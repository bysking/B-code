import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Spinner } from "../src/ui.js";

function makeStream() {
  let text = "";
  return {
    write(chunk: string): boolean {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

test("非 TTY（disabled）→ start/stop 零写入（管道/CI 不产生动画帧）", () => {
  const stream = makeStream();
  const sp = new Spinner(stream, false);
  sp.start("thinking…");
  sp.stop();
  assert.equal(stream.text, "");
});

test("TTY：start 渲染帧 → tick 推进多帧 → stop 以擦行结尾", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const stream = makeStream();
    const sp = new Spinner(stream, true);
    sp.start("working…");
    const first = stream.text;
    assert.match(first, /\r\x1b\[K/, "首帧带擦行+回到行首");
    assert.ok(first.includes("working…"));

    mock.timers.tick(160); // 推进 2 帧
    const mid = stream.text;
    assert.ok(mid.length > first.length, "多帧推进会产生更多字节");

    sp.stop();
    assert.ok(stream.text.endsWith("\r\x1b[K"), "stop 后遮罩当前行");
  } finally {
    mock.timers.reset();
  }
});

test("stop 幂等：重复 stop 不重复写入", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const stream = makeStream();
    const sp = new Spinner(stream, true);
    sp.start("x");
    const before = stream.text;
    sp.stop();
    const stopped = stream.text;
    sp.stop();
    assert.equal(stream.text, stopped, "二次 stop 无新增字节");
    assert.ok(stopped.length > before.length);
  } finally {
    mock.timers.reset();
  }
});

test("update 可改提示文案", () => {
  const stream = makeStream();
  const sp = new Spinner(stream, true);
  sp.start("phase1…");
  sp.update("phase2…");
  sp.stop();
  mock.timers.reset();
});