import test from "node:test";
import assert from "node:assert/strict";
import { extractFileSources } from "../../../src/services/onebot/messageSegments.ts";

test("extractFileSources treats NapCat file_id as a resolvable OneBot file source", () => {
  const [source] = extractFileSources([{
    type: "file",
    data: {
      file: "铅毒之果.pdf",
      file_id: "077a6286f95b09df",
      file_size: 3673240
    }
  }]);

  assert.deepEqual(source, {
    sourceKind: "onebot_file",
    fileId: "077a6286f95b09df",
    busid: null,
    filename: "铅毒之果.pdf",
    mimeType: null,
    sizeBytes: 3673240
  });
});

test("extractFileSources does not treat a bare file name as an importable path", () => {
  const sources = extractFileSources([{
    type: "file",
    data: {
      file: "report.pdf"
    }
  }]);

  assert.deepEqual(sources, []);
});

test("extractFileSources keeps direct file urls as direct sources", () => {
  const [source] = extractFileSources([{
    type: "file",
    data: {
      url: "https://example.com/report.pdf",
      file: "report.pdf",
      file_id: "file-1",
      busid: 1,
      mime_type: "application/pdf"
    }
  }]);

  assert.deepEqual(source, {
    sourceKind: "direct",
    source: "https://example.com/report.pdf",
    fileId: "file-1",
    busid: 1,
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: null
  });
});
