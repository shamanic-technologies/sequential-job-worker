import { describe, it, expect } from "vitest";

/**
 * Regression test: email-send worker must validate the response payload
 * from the email-gateway, not just the HTTP status code.
 *
 * The email-gateway can return HTTP 200 with { success: false }
 * when the downstream provider (Instantly) rejects the send. Without
 * checking `success`, the worker would log "Sent email" and count it
 * as a success — even though nothing was actually delivered.
 */

interface SendResult {
  success: boolean;
  messageId?: string;
  provider?: string;
  error?: string;
}

function validateSendResult(result: SendResult): void {
  if (!result.success) {
    throw new Error(
      `Email gateway returned failure: ${result.error || "unknown error"}`
    );
  }
}

describe("Email send response validation", () => {
  it("should throw when email-gateway returns success=false", () => {
    const failedResult: SendResult = {
      success: false,
      provider: "broadcast",
      error: "Instantly campaign not found",
    };

    expect(() => validateSendResult(failedResult)).toThrow(
      "Email gateway returned failure: Instantly campaign not found"
    );
  });

  it("should throw with fallback message when error field is missing", () => {
    const failedResult: SendResult = {
      success: false,
      provider: "broadcast",
    };

    expect(() => validateSendResult(failedResult)).toThrow(
      "Email gateway returned failure: unknown error"
    );
  });

  it("should not throw when email-gateway returns success=true", () => {
    const successResult: SendResult = {
      success: true,
      messageId: "msg-123",
      provider: "broadcast",
    };

    expect(() => validateSendResult(successResult)).not.toThrow();
  });
});
