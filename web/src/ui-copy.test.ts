import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUiCopyCatalog, setUiCopyLanguage, uiCopy } from "./ui-copy.js";

describe("uiCopy", () => {
  beforeEach(() => {
    setUiCopyLanguage("zh-CN");
  });

  afterEach(() => {
    setUiCopyLanguage("zh-CN");
  });

  it("keeps major UI surfaces grouped by namespace", () => {
    expect(uiCopy.chat.preferencesPanel.title).toBe("个人设置");
    expect(uiCopy.userSpace.unsavedClose.titleOne).toBe("关闭未保存文件？");
    expect(uiCopy.rbacAdmin.dashboard.title).toBe("权限管理");
    expect(uiCopy.pwaPlatform.matrixTitle).toBe("支持范围");
    expect(uiCopy.rbacAdmin.tabs.agents).toBe("Agent治理");
  });

  it("switches UI copy by language while leaving mock agents unchanged", () => {
    setUiCopyLanguage("en-US");

    expect(uiCopy.chat.preferencesPanel.title).toBe("Personal settings");
    expect(uiCopy.userSpace.unsavedClose.titleOne).toBe("Close unsaved file?");
    expect(uiCopy.userSpace.directoryRuntimeRestarting).toBe(
      "User space is recovering. Retrying automatically.",
    );
    expect(uiCopy.userSpace.openPreviewInNewWindow).toBe("Open in new window");
    expect(uiCopy.userSpace.returnPreviewToTabs).toBe("Return to tab group");
    expect(uiCopy.rbacAdmin.dashboard.title).toBe("Access Management");
    expect(uiCopy.pwaPlatform.matrixTitle).toBe("Support scope");
    expect(uiCopy.rbacAdmin.tabs.agents).toBe("Agent governance");
    expect(uiCopy.agents.items.agent.name).toBe("Agent");
    expect(uiCopy.browserBridge.tabs(2)).toBe("2 tabs");
    expect(uiCopy.browserBridge.sessions(1)).toBe("1 Agent sessions");
    expect(uiCopy.browserBridge.connectedProfiles(1)).toContain("1 Chrome profiles");
    expect(uiCopy.browserBridge.verifySuccess(42)).toContain("42 ms");
    expect(uiCopy.browserBridge.missingArtifacts("extension")).toBe("Missing: extension");
    expect(uiCopy.browserBridge.controlEpoch(3)).toBe("Control epoch 3");

    setUiCopyLanguage("zh-CN");
    expect(uiCopy.chat.preferencesPanel.title).toBe("个人设置");
    expect(uiCopy.common.reload).toBe("重新加载");
    expect(uiCopy.appError.runtimeErrorTitle).toBe("发生运行时错误");
    expect(uiCopy.appError.recoverPageDescription).toBe("请重新加载页面以恢复。错误已上报。");
    expect(uiCopy.userSpace.directoryRuntimeRestarting).toBe("用户空间正在恢复，稍后将自动重试。");
    expect(uiCopy.userSpace.openPreviewInNewWindow).toBe("在新窗口打开");
    expect(uiCopy.userSpace.returnPreviewToTabs).toBe("移回标签组");
    expect(uiCopy.browserBridge.tabs(2)).toBe("2 个标签页");
    expect(uiCopy.browserBridge.sessions(1)).toBe("1 个 Agent 会话");
    expect(uiCopy.browserBridge.connectedProfiles(1)).toContain("1 个 Chrome 配置");
    expect(uiCopy.browserBridge.verifySuccess(42)).toContain("42 ms");
    expect(uiCopy.browserBridge.missingArtifacts("扩展")).toBe("缺少：扩展");
    expect(uiCopy.browserBridge.controlEpoch(3)).toBe("控制轮次 3");
  });

  it("keeps the lightweight Markdown toolbar localized", () => {
    expect(uiCopy.markdownEditor.topBar.actions.bold).toBe("加粗");
    setUiCopyLanguage("en-US");
    expect(uiCopy.markdownEditor.topBar.actions.bold).toBe("Bold");
    expect(uiCopy.markdownEditor.blockEdit.textGroup.h1).toBe("Heading 1");
  });

  it("keeps Pi runtime and interaction controls synchronized in both languages", () => {
    expect(getUiCopyCatalog("zh-CN").toolBlock.editNumber(2, 3)).toBe("编辑 2/3");
    expect(uiCopy.piRuntime.invalidSessionCreateResponse).toContain("无效的 Pi");
    expect(uiCopy.piRuntime.sessionCreationFailed).toBe("Pi 会话创建失败。");
    expect(uiCopy.piRuntime.sessionCreateStreamEnded).toContain("返回结果前");
    expect(uiCopy.piRuntime.thinkingLevel).toBe("推理强度");
    expect(uiCopy.piRuntime.thinkingLevels.max).toBe("最大");
    expect(uiCopy.piRuntime.reasoningModelDescription).toContain("推理");
    expect(uiCopy.piRuntime.toolStatus.cancelled).toBe("已取消");
    expect(uiCopy.interaction.executePlan).toBe("执行计划");
    expect(uiCopy.interaction.continuePlanning).toBe("继续规划");
    expect(uiCopy.interaction.freeTextOption).toBe("自由输入");
    expect(uiCopy.interaction.finishSelection).toBe("完成选择");

    setUiCopyLanguage("en-US");
    expect(getUiCopyCatalog("en-US").toolBlock.editNumber(2, 3)).toBe("Edit 2/3");
    expect(uiCopy.piRuntime.invalidSessionCreateResponse).toContain("invalid Pi");
    expect(uiCopy.piRuntime.sessionCreationFailed).toBe("Pi session creation failed.");
    expect(uiCopy.piRuntime.sessionCreateStreamEnded).toContain("before returning a result");
    expect(uiCopy.piRuntime.thinkingLevel).toBe("Reasoning effort");
    expect(uiCopy.piRuntime.thinkingLevels.max).toBe("Maximum");
    expect(uiCopy.piRuntime.reasoningModelDescription).toContain("reasoning");
    expect(uiCopy.piRuntime.toolStatus.cancelled).toBe("Cancelled");
    expect(uiCopy.interaction.executePlan).toBe("Execute plan");
    expect(uiCopy.interaction.continuePlanning).toBe("Continue planning");
    expect(uiCopy.interaction.freeTextOption).toBe("Enter a free-text answer");
    expect(uiCopy.interaction.finishSelection).toBe("Finish selection");
  });

  it("formats Office resource status in both languages", () => {
    const zh = getUiCopyCatalog("zh-CN");
    expect(zh.chat.preferencesPanel.officeResources.summary(2, 3)).toBe("2 / 3 个文件已缓存");
    expect(zh.chat.preferencesPanel.officeResources.failedFiles(1)).toBe("1 个文件加载失败");
    expect(zh.chat.preferencesPanel.officeResources.downloadProgress("1 MB", "2 MB")).toBe(
      "正在下载 1 MB / 2 MB",
    );
    expect(zh.chat.preferencesPanel.officeResources.verifyProgress("1 MB", "2 MB")).toBe(
      "正在校验 1 MB / 2 MB",
    );
    expect(zh.chat.preferencesPanel.officeResources.categoryProgressLabel("字体")).toBe(
      "字体缓存进度",
    );
    expect(
      zh.chat.preferencesPanel.officeResources.errors.insufficientStorage("1 MB", "2 MB"),
    ).toBe("浏览器存储空间不足：可用 1 MB，需要 2 MB。请释放空间或退出无痕模式。");

    const en = getUiCopyCatalog("en-US");
    expect(en.chat.preferencesPanel.officeResources.summary(2, 3)).toBe("2 / 3 files cached");
    expect(en.chat.preferencesPanel.officeResources.failedFiles(1)).toBe("1 file failed to load");
    expect(en.chat.preferencesPanel.officeResources.failedFiles(2)).toBe("2 files failed to load");
    expect(en.chat.preferencesPanel.officeResources.downloadProgress("1 MB", "2 MB")).toBe(
      "Downloading 1 MB / 2 MB",
    );
    expect(en.chat.preferencesPanel.officeResources.verifyProgress("1 MB", "2 MB")).toBe(
      "Verifying 1 MB / 2 MB",
    );
    expect(en.chat.preferencesPanel.officeResources.categoryProgressLabel("Fonts")).toBe(
      "Fonts cache progress",
    );
    expect(
      en.chat.preferencesPanel.officeResources.errors.insufficientStorage("1 MB", "2 MB"),
    ).toBe(
      "Not enough browser storage: 1 MB available, 2 MB required. Free space or leave private browsing.",
    );
    expect(en.userSpace.office.resourcePreparationDescription("24 MB")).toContain("24 MB");
  });
});
