/**
 * Answers go out compressed when the browser accepts it: a page of rows is
 * JSON that shrinks five to ten times. Brotli first, then gzip; anything
 * under 1 KiB, and what is compressed already (images, archives, the built
 * files that come with their own compressed copies), goes out as it is.
 */
import compress from "@fastify/compress";
import type { FastifyInstance } from "fastify";

/** Register before the routes: each one gets the hook as it is added. */
export async function registerCompression(app: FastifyInstance): Promise<void> {
  await app.register(compress, {
    encodings: ["br", "gzip"],
    threshold: 1024,
    // Answers only. A compressed request body is not unpacked: a few bytes
    // could inflate far past the size a body may have.
    globalDecompression: false,
  });
}
