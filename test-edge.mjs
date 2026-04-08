import fs from "fs";
import edgeTTS from "edge-tts";

async function main() {
  const outputPath = "./audios/test.mp3";

  const stream = await edgeTTS.stream({
    text: "Hello, I am your AI avatar. Nice to meet you.",
    voice: "en-US-AriaNeural",
  });

  const fileStream = fs.createWriteStream(outputPath);

  for await (const chunk of stream) {
    if (chunk.type === "audio") {
      fileStream.write(chunk.data);
    }
  }

  fileStream.end();
  console.log("Audio saved:", outputPath);
}

main().catch(console.error);