# AI StudyHub — YouTube Video Summarizer & Study Assistant

> Turn any YouTube video into concise executive summaries, timestamped chapters, interactive quizzes, flashcards, and a live Q&A chatbot in seconds.

---

## Why I Built This

We've all been there: staring at a massive 2-hour YouTube tutorial or lecture, scrubbing through the timeline just to find the key takeaways. 

**AI StudyHub** solves this by extracting transcripts from YouTube videos and using Google's Gemini AI model to generate structured, actionable study materials automatically.

---

## Features At A Glance

- **Smart Video Search & Extraction:** Paste any YouTube link/ID, or search directly from the app.
- **Executive Summaries & Chapters:** Get the core objective, main key points, and clickable timestamped chapters.
- **Interactive Flashcards:** Flip cards to test your retention on key concepts.
- **Auto-Generated Quizzes:** Test your knowledge with multiple-choice questions complete with instant feedback and explanations.
- **Ask Video Assistant:** Chat directly with an AI that knows the exact transcript of the video to answer your specific questions.
- **Export to PDF:** Download your generated study notes for offline revision.

---

## Tech Stack

- **Backend:** Node.js, Express.js
- **AI Model:** Google Gemini API (`@google/genai`)
- **APIs & Tools:** `youtube-transcript`, YouTube Data API (`googleapis`), `jspdf`
- **Frontend:** HTML5, Modern CSS3, Vanilla JavaScript (served via Express `public/`)
- **Deployment:** GitHub Pages (Frontend) & Render (Backend)

---

## Quick Start (Run Locally)

### 1. Clone the repository
```bash
git clone "https://github.com/Urshivam-ui/AI_Video_Summrizer.git"
cd AI_Video_Summrizer
