import { expect, test, type Page } from "@playwright/test";

const projectPath = "/private/tmp/naru-e2e-projects/public/editor";

test.use({
  hasTouch: true,
  viewport: { width: 360, height: 780 },
  // Samsung's documented UA shape; the test browser remains Playwright Chromium.
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
});

test("Samsung Internet UA simulation of Android input and image paste", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    const frames: Array<Record<string, unknown>> = [];
    Object.defineProperty(window, "__naruInputFrames", { value: frames });
    const clipboardFrames: Array<Record<string, unknown>> = [];
    Object.defineProperty(window, "__naruClipboardFrames", { value: clipboardFrames });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data): void {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.type === "terminal.input") {
          frames.push(frame);
          return;
        }
        if (typeof frame.type === "string" && frame.type.startsWith("clipboard.image.")) {
          clipboardFrames.push(frame);
          if (frame.type === "clipboard.image.commit") {
            queueMicrotask(() => {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    type: "clipboard.image.result",
                    requestId: frame.requestId,
                    paneId: frame.paneId,
                    status: "attached",
                  }),
                }),
              );
            });
          }
          return;
        }
      }
      send.call(this, data);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.getByLabel("서버 절대 경로").isVisible()) {
    await page.getByLabel("서버 절대 경로").fill(projectPath);
    await page.getByLabel(/표시 이름/).fill("Naru Mobile Input");
    await page.getByRole("button", { name: "연결하기" }).click();
  }
  const surface = page.getByLabel("Main Codex Codex");
  await expect(surface).toHaveAttribute("data-control-role", "controller");
  await expect(surface.locator(".xterm-rows")).toContainText("FAKE_CODEX_READY");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    field.value = "";
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    field.value = "한";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertCompositionText",
        data: "한",
        isComposing: true,
      }),
    );
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
  });
  await expect.poll(() => sentInput(page)).toBe("한");

  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.value = "";
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "글";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "글" }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "글" }));
    const keydown = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    const beforeDelete = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    });
    field.dispatchEvent(beforeDelete);
    if (!beforeDelete.defaultPrevented) {
      field.value = "";
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      );
    }
  });
  await expect.poll(() => sentInput(page)).toBe("글\u007f");
  await expect(input).toHaveValue("");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "끝";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "끝" }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "끝" }));
    const beforeDelete = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: false,
      inputType: "deleteContentBackward",
    });
    field.dispatchEvent(beforeDelete);
    field.value = "";
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("끝\u007f");
  await expect(input).toHaveValue("");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "악";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "악" }));
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
        isComposing: true,
      }),
    );
    field.value = "아";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        isComposing: true,
      }),
    );
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "아" }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "아" }));
  });
  await expect.poll(() => sentInput(page)).toBe("아");
  await expect(input).toHaveValue("아");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "아거";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "거" }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "거" }));
  });
  await expect.poll(() => sentInput(page)).toBe("아거");

  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.value = "";
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "이전내용";
    field.dispatchEvent(
      new CompositionEvent("compositionupdate", { bubbles: true, data: "이전내용" }),
    );
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertCompositionText",
        data: "이전내용",
        isComposing: true,
      }),
    );
    field.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "이전내용" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("이전내용");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    const keydown = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    field.value = field.value.slice(0, -1);
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\u007f");
  await expect(input).toHaveValue("");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    for (let index = 0; index < 2; index += 1) {
      const keydown = new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keydown, "keyCode", { value: 229 });
      field.dispatchEvent(keydown);
      field.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
      );
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      );
    }
  });
  await expect.poll(() => sentInput(page)).toBe("\u007f\u007f");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "다";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "다" }));
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertCompositionText",
        data: "다",
        isComposing: true,
      }),
    );
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "다" }));
  });
  await expect.poll(() => sentInput(page)).toBe("다");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    const keydown = new KeyboardEvent("keydown", {
      key: "Unidentified",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    field.value = "";
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\u007f");
  await expect(input).toHaveValue("");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "새";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "새" }));
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertCompositionText",
        data: "새",
        isComposing: true,
      }),
    );
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "새" }));
  });
  await expect.poll(() => sentInput(page)).toBe("새");

  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const frameState = window as typeof window & { __naruInputFrames: unknown[] };
    frameState.__naruInputFrames.length = 0;
    const keydown = new KeyboardEvent("keydown", {
      key: "b",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.value += "b";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: "b",
      }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("b");
  for (const text of ["2", ".", "😀"]) {
    await input.evaluate((textarea, nextText) => {
      const field = textarea as HTMLTextAreaElement;
      const state = window as typeof window & { __naruInputFrames: unknown[] };
      state.__naruInputFrames.length = 0;
      const keydown = new KeyboardEvent("keydown", {
        key: nextText,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keydown, "keyCode", { value: 229 });
      field.dispatchEvent(keydown);
      field.value += nextText;
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: nextText,
        }),
      );
      field.dispatchEvent(new KeyboardEvent("keyup", { key: nextText, bubbles: true }));
    }, text);
    await expect.poll(() => sentInput(page)).toBe(text);
  }
  await surface
    .getByRole("toolbar", { name: "Main Codex 모바일 터미널 키" })
    .getByRole("button", { name: "Main Codex Ctrl 다음 키와 조합" })
    .click();
  await input.focus();
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    const keydown = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.value += "c";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: "c",
      }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\u0003");
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    const keydown = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertLineBreak" }),
    );
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
  });
  await expect.poll(() => sentInput(page)).toBe("\r");

  await page.getByRole("button", { name: "작업공간 메뉴 열기" }).click();
  const screenReaderToggle = page
    .getByRole("group", { name: "작업공간 메뉴" })
    .getByRole("button", { name: "스크린 리더 모드" });
  await screenReaderToggle.click();
  await expect(page.getByRole("button", { name: "작업공간 메뉴 열기" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await input.focus();
  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.value = "";
    const keydown = new KeyboardEvent("keydown", {
      key: "2",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    field.dispatchEvent(keydown);
    field.value = "2";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: "2",
      }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("2");
  await page.getByRole("button", { name: "작업공간 메뉴 열기" }).click();
  await page
    .getByRole("group", { name: "작업공간 메뉴" })
    .getByRole("button", { name: "스크린 리더 모드" })
    .click();
  await input.focus();

  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const frameState = window as typeof window & { __naruInputFrames: unknown[] };
    frameState.__naruInputFrames.length = 0;
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
    field.value = field.value.slice(0, -1);
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\u007f");

  await input.evaluate((textarea) => {
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    );
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\u007f");

  await input.evaluate((textarea) => {
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertLineBreak" }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\r");

  await input.evaluate((textarea) => {
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    for (let index = 0; index < 2; index += 1) {
      textarea.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertLineBreak" }),
      );
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }),
      );
    }
  });
  await expect.poll(() => sentInput(page)).toBe("\r\r");

  await input.evaluate((textarea) => {
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertLineBreak" }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }),
    );
  });
  await expect.poll(() => sentInput(page)).toBe("\r");

  await input.evaluate((textarea) => {
    const field = textarea as HTMLTextAreaElement;
    const state = window as typeof window & { __naruInputFrames: unknown[] };
    state.__naruInputFrames.length = 0;
    field.value = "";
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "글";
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "글" }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "글" }));
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
  });
  await expect.poll(() => sentInput(page)).toBe("글");
  await page.waitForTimeout(30);
  expect(await sentInput(page)).toBe("글");

  await surface.getByRole("button", { name: "한글 입력" }).click();
  const compose = surface.getByLabel("Main Codex 터미널로 보낼 텍스트");
  await expect(compose).toBeFocused();
  await compose.evaluate((textarea) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "mobile.png", { type: "image/png" }));
    Object.defineProperty(clipboard, "items", { value: [] });
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  });
  await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
    "Codex에 이미지 붙여넣기 요청을 보냈습니다.",
  );
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & { __naruClipboardFrames: Array<{ type: string }> }
      ).__naruClipboardFrames.map((frame) => frame.type),
    ),
  ).toEqual(["clipboard.image.begin", "clipboard.image.chunk", "clipboard.image.commit"]);

  await surface.locator(".xterm-screen").evaluate((screen) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "screen.png", { type: "image/png" }));
    screen.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __naruClipboardFrames: unknown[] }).__naruClipboardFrames
            .length,
      ),
    )
    .toBe(6);

  const textPasteCanceled = await compose.evaluate((textarea) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "ordinary text");
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    });
    textarea.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textPasteCanceled).toBe(false);

  await compose.evaluate((textarea) => {
    const clipboard = new DataTransfer();
    clipboard.setData("image/png", "not exposed as a file");
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  });
  await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
    "브라우저가 이미지 데이터를 제공하지 않았습니다.",
  );

  const observerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  try {
    const nextPage = await observerContext.newPage();
    await nextPage.goto("/");
    await nextPage.getByRole("button", { name: "비밀번호로 로그인" }).click();
    await nextPage.getByLabel("Naru 비밀번호").fill("naru-test-password");
    await nextPage.getByRole("button", { name: "작업공간 열기" }).click();
    await expect(nextPage.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    await nextPage.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");

    const inputBeforeHandoff = await sentInput(page);
    await input.evaluate((textarea) => {
      textarea.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
      );
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      );
    });
    expect(await sentInput(page)).toBe(inputBeforeHandoff);

    await compose.evaluate((textarea) => {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "observer.png", { type: "image/png" }));
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    });
    await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
      "현재 화면은 이 Codex Pane을 제어할 수 없습니다.",
    );
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __naruClipboardFrames: unknown[] }).__naruClipboardFrames
            .length,
      ),
    ).toBe(6);
  } finally {
    await observerContext.close();
  }
});

async function sentInput(page: Page): Promise<string> {
  return await page.evaluate(() =>
    (window as typeof window & { __naruInputFrames: Array<{ data: string }> }).__naruInputFrames
      .map((frame) => frame.data)
      .join(""),
  );
}
