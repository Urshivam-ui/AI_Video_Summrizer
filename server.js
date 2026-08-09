// Prevent silent process exits
const originalExit = process.exit;
process.exit = function (code) {
  console.error(`ATTEMPTED PROCESS EXIT WITH CODE (${code}):`);
  console.trace('Exit call stack trace:');
  if (code === 0) {
    console.error('Prevented silent exit code 0. Keeping server alive...');
    return; // Block silent clean exits
  }
  originalExit.call(this, code);
};

// Global error handlers to capture unhandled promise rejections or exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');
const { GoogleGenAI } = require('@google/genai');
const { jsPDF } = require('jspdf');
const { google } = require('googleapis');
require('dotenv').config();

// Environment check warnings
if (!process.env.GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is missing in your .env file!');
}
if (!process.env.YOUTUBE_API_KEY) {
  console.warn('WARNING: YOUTUBE_API_KEY is missing in your .env file!');
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Google Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Initialize YouTube Data API Client
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY || '',
});

// function to convert MM:SS or HH:MM:SS string to total seconds
function timestampToSeconds(timestampStr) {
  if (!timestampStr) return 0;
  const parts = timestampStr.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]; // MM:SS
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  }
  return 0;
}

// Gemini models if rate limit (429) or missing model (404) occurs
async function generateContentWithFallback(prompt) {
  const candidateModels = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
  ];

  for (const model of candidateModels) {
    try {
      console.log(` Requesting Gemini API using model: ${model}...`);
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });
      return response; // Return API response
    } catch (error) {
      const isRateLimited = error.status === 429 || (error.message && error.message.includes('429'));
      const isNotFound = error.status === 404 || (error.message && error.message.includes('404'));

      if (isRateLimited || isNotFound) {
        const reason = isRateLimited ? 'Rate limit (429)' : 'Model unavailable (404)';
        console.warn(` ${reason} for model ${model}. Retrying with next model...`);
        continue; // Fallback to next model in candidate list
      }
      throw error; // Re-throw other errors
    }
  }

  throw new Error('429: All available Gemini models reached rate limits. Please wait 60 seconds.');
}

// 1: Search YouTube Videos

app.get('/api/search', async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const response = await youtube.search.list({
      part: 'snippet',
      q: q,
      type: 'video',
      maxResults: 6,
      safeSearch: 'moderate',
    });

    if (!response.data || !response.data.items || response.data.items.length === 0) {
      return res.json({ success: true, videos: [] });
    }

    const videos = response.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
      channelTitle: item.snippet.channelTitle,
    }));

    res.json({ success: true, videos });
  } catch (error) {
    console.error('YouTube Search API Error:', error);
    res.status(500).json({ 
      error: 'Failed to search YouTube videos.',
      details: error.message 
    });
  }
});

// 2: Fetch Transcript & Summarize with Timestamps via Gemini

app.post('/api/summarize', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  try {
    // A: Fetch transcript items
    let transcriptItems = [];
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (transcriptError) {
      return res.status(422).json({
        error: 'Captions/Transcript not available for this video.',
        details: transcriptError.message
      });
    }

    if (!transcriptItems || transcriptItems.length === 0) {
      return res.status(422).json({ error: 'Video transcript is empty.' });
    }

    // B: Format transcript text with [MM:SS] timecodes
    const formattedTranscriptLines = transcriptItems.map(item => {
      const offsetMs = item.offset || 0;
      const totalSeconds = offsetMs > 10000 ? Math.floor(offsetMs / 1000) : Math.floor(offsetMs);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      return `[${timeStr}] ${item.text}`;
    });

    const fullTranscript = formattedTranscriptLines.join('\n');
    const truncatedTranscript = fullTranscript.slice(0, 14000);

    // C: Send prompt to Gemini API with fallback
    const prompt = `
      You are an educational assistant. Analyze the following timestamped video transcript and provide a response strictly in valid JSON format.
      
      JSON Structure:
      {
        "purpose": "A clear statement describing the main objective/purpose of this video.",
        "summary": "A concise executive summary of the entire video (3-4 sentences).",
        "keyPoints": [
          "Key takeaway 1",
          "Key takeaway 2",
          "Key takeaway 3",
          "Key takeaway 4"
        ],
        "chapters": [
          {
            "timestamp": "MM:SS",
            "title": "Short title describing this section/topic"
          }
        ]
      }

      Requirements:
      - Extract 4 to 6 major key moments/chapters with their corresponding timestamp in MM:SS format from the transcript.
      - Ensure timestamps strictly match the timecodes in brackets from the transcript text.
      - Do not include any extra markdown formatting like \`\`\`json outside the valid JSON object.

      Transcript:
      ${truncatedTranscript}
    `;

    const response = await generateContentWithFallback(prompt);
    const summaryData = JSON.parse(response.text);

    // D: Attach clickable YouTube URLs to each chapter
    if (Array.isArray(summaryData.chapters)) {
      summaryData.chapters = summaryData.chapters.map(chapter => {
        const seconds = timestampToSeconds(chapter.timestamp);
        return {
          ...chapter,
          seconds,
          url: `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`
        };
      });
    }

    res.json({ success: true, data: summaryData });
  } catch (error) {
    console.error('Error processing video with Gemini:', error);

    if (error.status === 429 || error.message.includes('rate limits')) {
      return res.status(429).json({
        error: 'Rate limit hit across models. Please wait 60 seconds before trying again.'
      });
    }

    res.status(500).json({ 
      error: 'Failed to generate summary with Gemini.',
      details: error.message 
    });
  }
});

// 3: Generate Quiz & Flashcards via Gemini

app.post('/api/quiz', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  try {
    // A: Fetch transcript
    let fullTranscript = '';
    try {
      const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
      fullTranscript = transcriptItems.map(item => item.text).join(' ');
    } catch (transcriptError) {
      return res.status(422).json({
        error: 'Captions/Transcript not available for this video.',
        details: transcriptError.message
      });
    }

    if (!fullTranscript || fullTranscript.trim().length === 0) {
      return res.status(422).json({ error: 'Video transcript is empty.' });
    }

    const truncatedTranscript = fullTranscript.slice(0, 12000);

    // B: Build prompt for Quiz & Flashcards
    const prompt = `
      You are an expert tutor creating study materials based on an educational video transcript.
      Generate a set of multiple-choice quiz questions and study flashcards based on the key concepts in the transcript.

      Respond STRICTLY in valid JSON format with the following structure:
      {
        "quiz": [
          {
            "id": 1,
            "question": "Clear, concise question testing comprehension",
            "options": [
              "Option A",
              "Option B",
              "Option C",
              "Option D"
            ],
            "correctAnswerIndex": 0,
            "explanation": "Short explanation of why this answer is correct."
          }
        ],
        "flashcards": [
          {
            "id": 1,
            "front": "Key term, concept, or prompt",
            "back": "Clear definition, explanation, or takeaway"
          }
        ]
      }

      Requirements:
      - Provide 5 distinct multiple-choice quiz questions.
      - Provide 5 high-yield flashcards.
      - Ensure options in quiz questions are plausible and test actual understanding.
      - Do not include markdown code block formatting like \`\`\`json outside the valid JSON object.

      Transcript:
      ${truncatedTranscript}
    `;

    const response = await generateContentWithFallback(prompt);
    const quizData = JSON.parse(response.text);

    res.json({
      success: true,
      quiz: quizData.quiz || [],
      flashcards: quizData.flashcards || []
    });

  } catch (error) {
    console.error('Error generating quiz with Gemini:', error);

    if (error.status === 429 || error.message.includes('rate limits')) {
      return res.status(429).json({
        error: 'Rate limit hit across models. Please wait 60 seconds before generating study materials again.'
      });
    }

    res.status(500).json({
      error: 'Failed to generate quiz and flashcards.',
      details: error.message
    });
  }
});

// 4: Interactive Q&A / Chat with Video Transcript

app.post('/api/chat', async (req, res) => {
  const { videoId, question } = req.body;

  if (!videoId || !question) {
    return res.status(400).json({ error: 'Both videoId and question are required.' });
  }

  try {
    // A: Fetch transcript
    let fullTranscript = '';
    try {
      const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
      fullTranscript = transcriptItems.map(item => item.text).join(' ');
    } catch (transcriptError) {
      return res.status(422).json({
        error: 'Captions/Transcript not available for this video.',
        details: transcriptError.message
      });
    }

    if (!fullTranscript || fullTranscript.trim().length === 0) {
      return res.status(422).json({ error: 'Video transcript is empty.' });
    }

    const truncatedTranscript = fullTranscript.slice(0, 14000);

    // B: Build prompt for Gemini Q&A
    const prompt = `
      You are an AI learning assistant helping a user understand an educational video.
      Answer the user's question accurately based on the video transcript provided. 
      If the transcript does not contain the answer, use your general knowledge to complement your answer, but state that it wasn't directly mentioned in the video.

      Keep your answer clear, helpful, and concise (2-4 paragraphs max).

      Video Transcript:
      ${truncatedTranscript}

      User Question:
      ${question}
    `;

    // C: Call Gemini API (Text response)
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt
    });

    res.json({
      success: true,
      answer: response.text
    });

  } catch (error) {
    console.error('Error in Video Chat API:', error);

    if (error.status === 429 || error.message.includes('rate limits')) {
      return res.status(429).json({
        error: 'Rate limit hit across models. Please wait 60 seconds before asking another question.'
      });
    }

    res.status(500).json({
      error: 'Failed to process chat question.',
      details: error.message
    });
  }
});

// 5: Dynamic PDF Generation

app.post('/api/generate-pdf', (req, res) => {
  try {
    const { title, purpose, summary, keyPoints } = req.body;

    const doc = new jsPDF();
    let y = 20;

    // Title Header
    doc.setFontSize(18);
    doc.text("Educational Video Summary", 14, y);

    y += 10;
    doc.setFontSize(11);
    doc.text(`Title: ${title || 'YouTube Educational Video'}`, 14, y);

    // Purpose Section
    y += 14;
    doc.setFontSize(13);
    doc.text("Purpose of Video:", 14, y);
    y += 6;
    doc.setFontSize(10);
    const purposeLines = doc.splitTextToSize(purpose || 'N/A', 180);
    doc.text(purposeLines, 14, y);
    y += (purposeLines.length * 5) + 8;

    // Summary Section
    doc.setFontSize(13);
    doc.text("Summary:", 14, y);
    y += 6;
    doc.setFontSize(10);
    const summaryLines = doc.splitTextToSize(summary || 'N/A', 180);
    doc.text(summaryLines, 14, y);
    y += (summaryLines.length * 5) + 8;

    // Key Takeaways Section
    doc.setFontSize(13);
    doc.text("Key Takeaways & Important Points:", 14, y);
    y += 8;
    doc.setFontSize(10);

    if (Array.isArray(keyPoints)) {
      keyPoints.forEach((point, index) => {
        const text = `${index + 1}. ${point}`;
        const lines = doc.splitTextToSize(text, 180);
        
        if (y + (lines.length * 5) > 280) {
          doc.addPage();
          y = 20;
        }

        doc.text(lines, 14, y);
        y += (lines.length * 5) + 3;
      });
    }

    const pdfOutput = doc.output('arraybuffer');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=video-summary.pdf');
    res.send(Buffer.from(pdfOutput));
  } catch (error) {
    console.error('PDF Generation Error:', error);
    res.status(500).json({ error: 'Failed to generate PDF document.' });
  }
});

// Express Error Handler
app.use((err, req, res, next) => {
  console.error('Express Internal Error:', err.stack);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

// Start Express Server
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});

// Server Event Monitors
server.on('error', (err) => {
  console.error(' Express Server Error:', err);
});

server.on('close', () => {
  console.warn(' Express Server Closed.');
});