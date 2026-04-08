import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { promises as fs } from "fs";
import Groq from "groq-sdk";

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const murfApiKey = process.env.MURF_API_KEY;

// You can use either a Murf voice ID like "en-US-natalie"
// or just the voice actor name like "Natalie"
const MURF_VOICE_ID = process.env.MURF_VOICE_ID || "Natalie";
const MURF_LOCALE = process.env.MURF_LOCALE || "en-US";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Allow any origin in dev; lock it to your Vercel URL in production via CORS_ORIGIN env var
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
}));

const port = process.env.PORT || 3125;

// Paths — set RHUBARB_PATH / FFMPEG_PATH in .env for local Windows dev.
// On Railway/Render (Linux) leave them blank to use system-installed binaries.
const RHUBARB_PATH = process.env.RHUBARB_PATH || "rhubarb";
const FFMPEG_PATH  = process.env.FFMPEG_PATH  || "ffmpeg";

app.get("/", (req, res) => {
  res.send("Groq + Murf backend is running");
});

// Optional: list Murf voices
app.get("/voices", async (req, res) => {
  try {
    if (!murfApiKey) {
      return res.status(400).send({ error: "MURF_API_KEY is missing" });
    }

    const response = await fetch("https://api.murf.ai/v1/speech/voices", {
      method: "GET",
      headers: {
        "api-key": murfApiKey,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Murf voices error: ${response.status} - ${errText}`);
    }

    const voices = await response.json();
    return res.send(voices);
  } catch (error) {
    console.error("Voices fetch error:", error);
    return res.status(500).send({
      error: "Failed to fetch Murf voices",
      details: error.message,
    });
  }
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Exec Error:", error);
        console.error("stderr:", stderr);
        reject(error);
        return;
      }

      if (stderr) {
        console.warn("Command stderr:", stderr);
      }

      resolve(stdout);
    });
  });
};

const ensureAudiosFolder = async () => {
  try {
    await fs.mkdir("audios", { recursive: true });
  } catch (error) {
    console.error("Error creating audios folder:", error);
  }
};

const readJsonTranscript = async (file) => {
  const data = await fs.readFile(file, "utf8");
  return JSON.parse(data);
};

const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString("base64");
};

// Download file from URL if Murf returns audioFile instead of encodedAudio
const downloadFile = async (url, outputFilePath) => {
  const response = await fetch(url);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Audio download failed: ${response.status} - ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(outputFilePath, buffer);
};

// Murf TTS
const generateMurfAudio = async (text, outputFilePath) => {
  if (!murfApiKey) {
    throw new Error("MURF_API_KEY is missing");
  }

  const response = await fetch("https://api.murf.ai/v1/speech/generate", {
    method: "POST",
    headers: {
      "api-key": murfApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceId: MURF_VOICE_ID,
      locale: MURF_LOCALE,
      format: "MP3",
      sampleRate: 44100,
      channelType: "MONO",
      encodeAsBase64: true,
      modelVersion: "GEN2",
      rate: 0,
      pitch: 0,
      variation: 1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Murf TTS failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();

  // Preferred: write encoded audio directly
  if (data?.encodedAudio) {
    const buffer = Buffer.from(data.encodedAudio, "base64");
    await fs.writeFile(outputFilePath, buffer);
    return;
  }

  // Fallback: download from audioFile URL
  if (data?.audioFile) {
    await downloadFile(data.audioFile, outputFilePath);
    return;
  }

  throw new Error("Murf response did not contain encodedAudio or audioFile");
};

const lipSyncMessage = async (messageIndex) => {
  const time = Date.now();
  console.log(`Starting conversion for message ${messageIndex}`);

  const mp3Path = `audios/message_${messageIndex}.mp3`;
  const wavPath = `audios/message_${messageIndex}.wav`;
  const jsonPath = `audios/message_${messageIndex}.json`;

  await execCommand(`"${FFMPEG_PATH}" -y -i "${mp3Path}" "${wavPath}"`);
  console.log(`MP3 to WAV done in ${Date.now() - time}ms`);

  await execCommand(
    `"${RHUBARB_PATH}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
  );
  console.log(`Lip sync done in ${Date.now() - time}ms`);
};

// 🔹 In-memory chat history (you can later replace with DB)
let chatHistory = [];

app.post("/chat", async (req, res) => {
  try {
    if (pythonMode) {
      console.log("🔒 /chat blocked — pythonMode active");
      return res.status(423).json({ error: "python mode active" });
    }

    await ensureAudiosFolder();

    const userMessage = req.body.message;

    // 🔹 Default intro if no message
    if (!userMessage) {
      return res.send({
        messages: [
          {
            text: "Hey dear. How are you feeling today?",
            audio: await audioFileToBase64("audios/intro_0.wav"),
            lipsync: await readJsonTranscript("audios/intro_0.json"),
            facialExpression: "smile",
            animation: "Talking_1",
          },
          {
            text: "You can tell me anything. I'm here to help you 💙",
            audio: await audioFileToBase64("audios/intro_1.wav"),
            lipsync: await readJsonTranscript("audios/intro_1.json"),
            facialExpression: "smile",
            animation: "Talking_2",
          },
        ],
      });
    }

    // 🔹 API key check
    if (!murfApiKey || !process.env.GROQ_API_KEY) {
      return res.send({
        messages: [
          {
            text: "Please add your API keys first.",
            audio: await audioFileToBase64("audios/api_0.wav"),
            lipsync: await readJsonTranscript("audios/api_0.json"),
            facialExpression: "angry",
            animation: "Angry",
          },
        ],
      });
    }

    // 🔹 Add user message to memory
    chatHistory.push({
      role: "user",
      content: userMessage,
    });

    // 🔹 Limit memory (last 30 messages)
    if (chatHistory.length > 30) {
      chatHistory = chatHistory.slice(-30);
    }

    // 🔥 AI CALL
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `
You are Sanjeevni AI, a friendly and caring virtual doctor.

Your personality:
- Talk like a real human doctor (warm, polite, supportive)
- Understand the user's problem first
- Answer doubts clearly and directly
- Ask follow-up questions if needed
- Keep it simple and helpful

Conversation rules:
- Always respond based on latest user message
- Do not repeat previous answers
- Be conversational, not robotic
- Maximum 3 messages

STRICT OUTPUT:
Return ONLY valid JSON.

Format:
{
  "messages": [
    {
      "text": "string",
      "facialExpression": "smile | sad | angry | surprised | funnyFace | default",
      "animation": "Talking_0 | Talking_1 | Talking_2 | Crying | Laughing | Rumba | Idle | Terrified | Angry"
    }
  ]
}

Emotion guide:
- Greeting → smile + Talking_1
- Explanation → default + Talking_0
- Reassuring → smile + Talking_2
- Serious → sad + Talking_1

NO markdown
NO extra text
ONLY JSON
`,
        },
        ...chatHistory,
      ],
    });

    const raw = completion.choices[0]?.message?.content || "";
    console.log("🧠 Groq raw:", raw);

    let messages;

    // 🔹 Safe JSON parsing
    try {
      const parsed = JSON.parse(raw);
      messages = parsed.messages || parsed;
    } catch (err) {
      console.error("❌ JSON parse error:", err);

      messages = [
        {
          text: raw || "Sorry, I didn't understand that properly.",
          facialExpression: "default",
          animation: "Talking_1",
        },
      ];
    }

    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    // 🔹 Save assistant reply in memory (only text)
    chatHistory.push({
      role: "assistant",
      content: messages.map((m) => m.text).join(" "),
    });

    // 🔊 TTS + Lipsync processing
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const fileName = `audios/message_${i}.mp3`;
      const textInput = message.text || "Hello";

      console.log(`🔊 Generating audio ${i}:`, textInput);

      try {
        await generateMurfAudio(textInput, fileName);
        await lipSyncMessage(i);

        message.audio = await audioFileToBase64(fileName);
        message.lipsync = await readJsonTranscript(
          `audios/message_${i}.json`
        );
      } catch (ttsError) {
        console.error("⚠️ TTS/Lipsync failed:", ttsError.message);

        message.audio = null;
        message.lipsync = { mouthCues: [] };
      }
    }

    return res.send({ messages });

  } catch (error) {
    console.error("🔥 Chat route error:", error);

    return res.status(500).send({
      error: "Something went wrong in /chat",
      details: error.message,
    });
  }
});
app.listen(port, () => {
  console.log(`Virtual Girlfriend listening on port ${port}`);
  console.log(`Rhubarb path: ${RHUBARB_PATH}`);
  console.log(`FFmpeg path: ${FFMPEG_PATH}`);
  console.log(`Murf voice: ${MURF_VOICE_ID}`);
  console.log(`Murf locale: ${MURF_LOCALE}`);
});


let latestTranscript = "";


app.post("/lip-sync", async (req, res) => {
  try {
    await ensureAudiosFolder();
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.status(400).send("No audioBase64 provided");

    console.log(`💋 Lip-sync audio size: ${audioBase64.length} chars`);

    const audioBuffer = Buffer.from(audioBase64, "base64");
    const mp3Path  = `audios/api_lipsync.mp3`;
    const wavPath  = `audios/api_lipsync.wav`;
    const jsonPath = `audios/api_lipsync.json`;

    await fs.writeFile(mp3Path, audioBuffer);
    console.log("💋 Audio written, starting FFmpeg...");

    await execCommand(`"${FFMPEG_PATH}" -y -i "${mp3Path}" "${wavPath}"`);
    console.log("💋 WAV ready, starting Rhubarb...");

    await execCommand(
      `"${RHUBARB_PATH}" -f json -o "${jsonPath}" "${wavPath}" -r phonetic`
    );
    console.log("💋 Rhubarb done");

    const lipsync = await readJsonTranscript(jsonPath);
    console.log(`💋 Mouth cues: ${lipsync.mouthCues?.length}`);
    res.send({ lipsync });
  } catch (err) {
    console.error("Lip-sync error:", err);
    res.status(500).send({ error: err.message });
  }
});

app.post("/set-transcript", (req, res) => {
  latestTranscript = req.body.transcript || "";
  console.log("📥 Transcript received:", latestTranscript);
  res.send({ ok: true });
});

app.get("/get-transcript", (req, res) => {
  res.send({ transcript: latestTranscript });
  latestTranscript = ""; // clear after reading
});

let pythonMode       = false;   // true = Python is in charge, React must stay silent
let latestAvatarPayload = null; // stores the payload Python sends

// ── Python calls this BEFORE Get Diagnosis starts processing ────────────────
app.post("/python-mode", (req, res) => {
  pythonMode = req.body.active === true;
  console.log("🐍 pythonMode:", pythonMode);
  res.json({ ok: true, pythonMode });
});

// ── React polls this to know whether to stay silent ────────────────────────
app.get("/python-mode", (req, res) => {
  res.json({ pythonMode });
});

// ── Python pushes full avatar payload here ─────────────────────────────────
app.post("/play-avatar", (req, res) => {
  const { text, audio, lipsync } = req.body;
  if (!audio) return res.status(400).json({ error: "audio required" });

  latestAvatarPayload = {
    text,
    audio,
    lipsync:          lipsync || { mouthCues: [] },
    facialExpression: "smile",
    animation:        "Talking_1",
    timestamp:        Date.now(),
  };
  console.log("✅ /play-avatar stored:", text?.slice(0, 60));
  res.json({ ok: true });
});

// ── React polls this to pick up the payload ────────────────────────────────
app.get("/get-avatar-payload", (req, res) => {
  if (!latestAvatarPayload) return res.json({ payload: null });
  const p         = latestAvatarPayload;
  latestAvatarPayload = null;   // one-shot — clear after reading
  res.json({ payload: p });
});
