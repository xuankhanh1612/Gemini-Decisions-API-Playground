# Gemini Decisions API Playground

Try the Gemini Decisions API: ask boolean, choice and score questions about
text, images, audio, video and PDFs, and get calibrated probabilities back in
one call.

- `npm run dev` serves the playground on port 3000.
- The page calls `POST https://generativelanguage.googleapis.com/v1beta/decisions`
  directly with the `gemini-decision-1` model. AI Studio supplies the API key.
- If the API can't be used, the six examples still show answers recorded from
  the live model.

The UI is plain JavaScript (Preact + htm, vendored) in `public/`, with no build
step of its own.
