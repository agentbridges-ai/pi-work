import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useStore } from "../store.js";
import { createClientMessageId, sendToSession } from "../ws.js";
import { api } from "../api.js";
import {
  modelRefEquals,
  normalizeThinkingLevel,
  THINKING_LEVELS,
  toModelOptions,
  type ModelOption,
} from "../utils/backends.js";
import type { PiModelRef, ThinkingLevel } from "../types.js";
import { uiCopy } from "../ui-copy.js";
import { Label, Slider } from "./ui/heroui.js";
import { DropdownMotion } from "./ui/index.js";

interface ModelSwitcherProps {
  sessionId: string;
}

function displayModel(model: PiModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

export function ModelSwitcher({ sessionId }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [dynamicModels, setDynamicModels] = useState<ModelOption[]>([]);
  const [optimisticModel, setOptimisticModel] = useState<PiModelRef | null>(null);
  const [optimisticThinking, setOptimisticThinking] = useState<ThinkingLevel | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const runtimeSession = useStore(
    (state) => state.runtimeSessions.find((session) => session.sessionId === sessionId) || null,
  );
  const sessionState = useStore((state) => state.sessions.get(sessionId));
  const agentId = useStore((state) => state.selectedAgentId);

  const currentModel = sessionState?.model ?? runtimeSession?.model;
  const currentThinking = normalizeThinkingLevel(
    sessionState?.thinkingLevel ?? runtimeSession?.thinkingLevel,
  );
  const selectedModel = optimisticModel ?? currentModel;
  const selectedThinking = optimisticThinking ?? currentThinking;

  const models = useMemo(() => {
    if (
      !selectedModel ||
      dynamicModels.some((option) => modelRefEquals(option.model, selectedModel))
    ) {
      return dynamicModels;
    }
    return [
      {
        value: selectedModel.key,
        label: displayModel(selectedModel),
        description: "",
        icon: "◆",
        model: selectedModel,
        thinkingLevels: [selectedThinking],
      },
      ...dynamicModels,
    ];
  }, [dynamicModels, selectedModel, selectedThinking]);

  const currentOption =
    models.find((option) => modelRefEquals(option.model, selectedModel)) ?? models[0] ?? null;
  const supportedThinkingLevels =
    currentOption?.thinkingLevels.length > 0 ? currentOption.thinkingLevels : [...THINKING_LEVELS];
  const selectedThinkingIndex = Math.max(0, supportedThinkingLevels.indexOf(selectedThinking));

  const updateRuntimeSession = useCallback(
    (updates: { model?: PiModelRef; thinkingLevel?: ThinkingLevel }) => {
      const store = useStore.getState();
      store.updateSession(sessionId, updates);
      store.setRuntimeSessions(
        store.runtimeSessions.map((session) =>
          session.sessionId === sessionId ? { ...session, ...updates } : session,
        ),
      );
    },
    [sessionId],
  );

  const handleSelectModel = useCallback(
    (option: ModelOption) => {
      setOpen(false);
      if (
        modelRefEquals(option.model, selectedModel) &&
        modelRefEquals(option.model, currentModel)
      ) {
        return;
      }
      setOptimisticModel(option.model);
      sendToSession(sessionId, {
        type: "set_model",
        model: option.model,
        clientMsgId: createClientMessageId(),
      });
      updateRuntimeSession({ model: option.model });
    },
    [currentModel, selectedModel, sessionId, updateRuntimeSession],
  );

  const handleSelectThinking = useCallback(
    (thinkingLevel: ThinkingLevel) => {
      if (thinkingLevel === selectedThinking && thinkingLevel === currentThinking) return;
      setOptimisticThinking(thinkingLevel);
      sendToSession(sessionId, {
        type: "set_thinking_level",
        thinkingLevel,
        clientMsgId: createClientMessageId(),
      });
      updateRuntimeSession({ thinkingLevel });
    },
    [currentThinking, selectedThinking, sessionId, updateRuntimeSession],
  );

  useEffect(() => {
    let active = true;
    setDynamicModels([]);
    api
      .getBackendModels(agentId)
      .then((modelsResult) => {
        if (active) setDynamicModels(toModelOptions(modelsResult));
      })
      .catch(() => {
        if (active) setDynamicModels([]);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  useEffect(() => {
    if (optimisticModel && modelRefEquals(currentModel, optimisticModel)) {
      setOptimisticModel(null);
    }
  }, [currentModel, optimisticModel]);

  useEffect(() => {
    if (optimisticThinking && currentThinking === optimisticThinking) {
      setOptimisticThinking(null);
    }
  }, [currentThinking, optimisticThinking]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(
      0,
      models.findIndex((option) => modelRefEquals(option.model, selectedModel)),
    );
    setActiveIndex(selectedIndex);
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
  }, [models, open, selectedModel]);

  if (!currentOption || !selectedModel) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
        className={`flex h-[var(--piwork-composer-control-size)] min-h-[var(--piwork-composer-control-size)] max-w-[220px] cursor-pointer items-center gap-1 rounded-[var(--piwork-control-radius)] px-2 text-sm font-normal transition-colors hover:bg-muted ${
          open ? "bg-muted" : "bg-transparent"
        } ${open ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        title={uiCopy.common.currentModel(displayModel(selectedModel))}
        aria-label={uiCopy.common.switchModel}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="truncate">{currentOption.label}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.9}
          aria-hidden="true"
        />
      </button>

      <DropdownMotion
        open={open}
        placement="top"
        className="piwork-superellipse-panel absolute bottom-full right-0 z-[var(--piwork-z-popover)] mb-1 flex max-h-[360px] min-w-[280px] flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-card p-1"
        role="dialog"
        aria-label={uiCopy.common.selectModel}
      >
        <div
          role="listbox"
          aria-label={uiCopy.common.selectModel}
          aria-activedescendant={models[activeIndex] ? `model-option-${activeIndex}` : undefined}
        >
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
            {uiCopy.common.model}
          </div>
          {models.map((option, index) => {
            const selected = modelRefEquals(option.model, selectedModel);
            return (
              <button
                key={option.value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`model-option-${index}`}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onClick={() => {
                  handleSelectModel(option);
                  triggerRef.current?.focus();
                }}
                className={`flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-[var(--piwork-control-radius)] px-2.5 text-[13px] transition-colors ${
                  selected
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                role="option"
                aria-selected={selected}
              >
                <span className="flex-1 truncate text-left">{option.label}</span>
                {selected && (
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3.5 w-3.5 shrink-0 text-foreground"
                    aria-hidden="true"
                  >
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        <Slider
          className="mt-1 border-t border-border px-2 pb-2 pt-2 [--color-accent:var(--primary)]"
          minValue={0}
          maxValue={Math.max(0, supportedThinkingLevels.length - 1)}
          step={1}
          value={selectedThinkingIndex}
          onChange={(value) => {
            const index = Array.isArray(value) ? value[0] : value;
            const level = supportedThinkingLevels[index ?? 0];
            if (level) handleSelectThinking(level);
          }}
        >
          <Label className="text-xs font-semibold text-muted-foreground">
            {uiCopy.piRuntime.thinkingLevel}
          </Label>
          <Slider.Track className="h-2 rounded-full border-x-[0.5rem] bg-muted">
            <Slider.Fill className="bg-primary" />
            <Slider.Thumb className="size-5 bg-transparent after:size-4 after:rounded-full after:bg-foreground" />
          </Slider.Track>
          <Slider.Marks
            className="col-span-2 mt-1 grid text-xs leading-4 text-muted-foreground"
            style={{
              gridTemplateColumns: `repeat(${supportedThinkingLevels.length}, minmax(0, 1fr))`,
            }}
          >
            {supportedThinkingLevels.map((level, index) => (
              <span
                key={level}
                className={
                  index === 0
                    ? "text-left"
                    : index === supportedThinkingLevels.length - 1
                      ? "text-right"
                      : "text-center"
                }
              >
                {uiCopy.piRuntime.thinkingLevels[level]}
              </span>
            ))}
          </Slider.Marks>
        </Slider>
      </DropdownMotion>
    </div>
  );
}
