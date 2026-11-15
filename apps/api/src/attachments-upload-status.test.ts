import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { attachmentUploadStatus } from "./attachments.js";

describe("attachmentUploadStatus", () => {
  it("answers a refused type with the rule's own status", () => {
    const failure = attachmentUploadStatus(
      new AppError("attachment_type_refused"),
    );
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("attachment_type_refused");
  });

  it("answers a broken store with 500 and no code", () => {
    expect(attachmentUploadStatus(new Error("disk"))).toEqual({
      status: 500,
    });
  });
});
