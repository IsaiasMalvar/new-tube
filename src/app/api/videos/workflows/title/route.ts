import { db } from "@/db";
import { videos } from "@/db/schema";
import { serve } from "@upstash/workflow/nextjs";
import { and, eq } from "drizzle-orm";
import { GenerateContentResponse } from "@google/generative-ai";

interface InputType {
  userId: string;
  videoId: string;
}
const TITLE_SYSTEM_PROMPT = `Your task is to generate an SEO-focused title for a YouTube video based on its transcript. Please follow these guidelines:
- Be concise but descriptive, using relevant keywords to improve discoverability.
- Highlight the most compelling or unique aspect of the video content.
- Avoid jargon or overly complex language unless it directly supports searchability.
- Use action-oriented phrasing or clear value propositions where applicable.
- Ensure the title is 3-8 words long and no more than 100 characters.
- ONLY return the title as plain text. Do not add quotes or any additional formatting.`;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

export const { POST } = serve(async (context) => {
  const input = context.requestPayload as InputType;
  const { videoId, userId } = input;

  const video = await context.run("get-video", async () => {
    const [existingVideo] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)));

    if (!existingVideo) {
      throw new Error("Not found");
    }

    return existingVideo;
  });

  const transcript = await context.run("get-transcript", async () => {
    const trackUrl = `https://stream.mux.com/${video.muxPlaybackId}/text/${video.muxTrackId}.txt`;
    const response = await fetch(trackUrl);
    const text = response.text();

    if (!text) {
      throw new Error("Bad Request");
    }

    return text;
  });

  const { body } = await context.call<GenerateContentResponse>(
    "generate-title",
    {
      method: "POST",
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        system_instruction: {
          parts: { text: TITLE_SYSTEM_PROMPT },
        },
        contents: {
          parts: {
            text: transcript,
          },
        },
      },
    },
  );

  await context.run("update-video", async () => {
    if (!body || !body.candidates) {
      throw new Error("Something went wrong");
    }

    await db
      .update(videos)
      .set({ title: body.candidates[0].content.parts[0].text })
      .where(and(eq(videos.id, video.id), eq(videos.userId, video.userId)));
  });
});
