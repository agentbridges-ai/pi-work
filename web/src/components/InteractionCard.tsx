import { useCallback, useEffect, useState } from "react";
import { createClientMessageId, sendToSession } from "../ws.js";
import { useStore } from "../store.js";
import type {
  AskInteractionRequest,
  InteractionRequest,
  InteractionResponse,
  ProposePlanInteractionRequest,
} from "../types.js";
import { uiCopy } from "../ui-copy.js";

export interface InteractionCardProps {
  interaction: InteractionRequest;
  sessionId: string;
  inline?: boolean;
}

export function InteractionCard({ interaction, sessionId, inline = false }: InteractionCardProps) {
  const [transportError, setTransportError] = useState("");
  const generation = useStore(
    (state) =>
      state.sessions.get(sessionId)?.generation ??
      state.runtimeSessions.find((session) => session.sessionId === sessionId)?.generation ??
      0,
  );
  const submission = useStore((state) =>
    state.interactionSubmissions.get(sessionId)?.get(interaction.id),
  );
  const submitting = Boolean(submission && submission.generation === generation);

  const submit = useCallback(
    (response: InteractionResponse): boolean => {
      if (submitting) return false;
      setTransportError("");
      const clientMsgId = createClientMessageId();
      const sent = sendToSession(sessionId, {
        type: "interaction_response",
        generation,
        timestamp: Date.now(),
        clientMsgId,
        ...response,
      });
      if (!sent) {
        setTransportError(uiCopy.interaction.sessionClosed);
        return false;
      }
      useStore.getState().markInteractionSubmitting(sessionId, interaction.id, {
        clientMsgId,
        generation,
        submittedAt: Date.now(),
      });
      return true;
    },
    [generation, interaction.id, sessionId, submitting],
  );

  useEffect(() => {
    if (!interaction.timeoutAt) return undefined;
    const delay = interaction.timeoutAt - Date.now();
    const timeout = window.setTimeout(
      () =>
        submit({
          requestId: interaction.id,
          kind: interaction.kind,
          status: "timed_out",
        } as InteractionResponse),
      Math.max(0, delay),
    );
    return () => window.clearTimeout(timeout);
  }, [interaction, submit]);

  const shellClass = inline ? "" : "border-b border-border px-2 py-3 sm:px-4";
  return (
    <div className={shellClass}>
      <div className="mx-auto max-w-3xl">
        {interaction.kind === "ask" ? (
          <AskInteraction
            request={interaction}
            disabled={submitting}
            error={transportError}
            onSubmit={submit}
          />
        ) : (
          <PlanInteraction
            request={interaction}
            disabled={submitting}
            error={transportError}
            onSubmit={submit}
          />
        )}
      </div>
    </div>
  );
}

function AskInteraction({
  request,
  disabled,
  error,
  onSubmit,
}: {
  request: AskInteractionRequest;
  disabled: boolean;
  error: string;
  onSubmit: (response: InteractionResponse) => boolean;
}) {
  const [answers, setAnswers] = useState<
    Record<string, { selectedOptionIds: string[]; freeText: string }>
  >({});
  const [activeQuestion, setActiveQuestion] = useState(0);
  const questions = request.questions;
  const safeActiveQuestion = Math.min(activeQuestion, Math.max(questions.length - 1, 0));
  const currentQuestion = questions[safeActiveQuestion];
  const currentAnswer = currentQuestion
    ? (answers[currentQuestion.id] ?? { selectedOptionIds: [], freeText: "" })
    : { selectedOptionIds: [], freeText: "" };
  const questionAnswered = (questionId: string) => {
    const answer = answers[questionId];
    return Boolean(answer?.selectedOptionIds.length || answer?.freeText.trim());
  };
  const currentQuestionAnswered = currentQuestion ? questionAnswered(currentQuestion.id) : false;
  const allQuestionsAnswered =
    questions.length > 0 && questions.every((question) => questionAnswered(question.id));
  const isLastQuestion = safeActiveQuestion === questions.length - 1;
  const optionButtonClass =
    "group/ask-option flex min-h-8 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] p-2 text-left text-[13px] font-normal leading-[18px] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 [corner-shape:superellipse(1.5)]";
  const askNavButtonClass =
    "flex h-8 items-center rounded-[var(--piwork-control-radius)] border border-transparent px-2.5 py-0 text-[13px] font-medium leading-[18px] transition-colors disabled:cursor-not-allowed";
  const askSecondaryButtonClass = `${askNavButtonClass} bg-muted text-muted-foreground hover:bg-accent/80 hover:text-foreground disabled:opacity-35`;
  const askPrimaryButtonClass = `${askNavButtonClass} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50`;

  const toggleOption = (optionId: string) => {
    if (!currentQuestion) return;
    setAnswers((current) => {
      const previous = current[currentQuestion.id] ?? {
        selectedOptionIds: [],
        freeText: "",
      };
      if (!currentQuestion.allowMultiple) {
        return {
          ...current,
          [currentQuestion.id]: { selectedOptionIds: [optionId], freeText: "" },
        };
      }
      const selectedOptionIds = previous.selectedOptionIds.includes(optionId)
        ? previous.selectedOptionIds.filter((id) => id !== optionId)
        : [...previous.selectedOptionIds, optionId];
      return {
        ...current,
        [currentQuestion.id]: { ...previous, selectedOptionIds },
      };
    });
  };

  const updateFreeText = (freeText: string) => {
    if (!currentQuestion) return;
    setAnswers((current) => {
      const previous = current[currentQuestion.id] ?? {
        selectedOptionIds: [],
        freeText: "",
      };
      return {
        ...current,
        [currentQuestion.id]: {
          selectedOptionIds: currentQuestion.allowMultiple ? previous.selectedOptionIds : [],
          freeText,
        },
      };
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || disabled) return;
      event.preventDefault();
      onSubmit({ requestId: request.id, kind: "ask", status: "cancelled" });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onSubmit, request.id]);

  const submitAnswers = () => {
    if (!allQuestionsAnswered) return;
    onSubmit({
      requestId: request.id,
      kind: "ask",
      status: "submitted",
      answers: questions.map((question) => {
        const answer = answers[question.id]!;
        return {
          questionId: question.id,
          selectedOptionIds: answer.selectedOptionIds,
          freeText: answer.freeText.trim() || undefined,
        };
      }),
    });
  };

  const advanceOrSubmit = () => {
    if (!currentQuestionAnswered) return;
    if (isLastQuestion) submitAnswers();
    else setActiveQuestion((value) => Math.min(questions.length - 1, value + 1));
  };

  if (!currentQuestion) return null;

  return (
    <section
      aria-label={request.title || uiCopy.interaction.askTitle}
      className="flex min-h-[142px] shrink-0 flex-col overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border/80 bg-card text-foreground [corner-shape:superellipse(1.5)]"
    >
      <div className="flex min-h-11 items-start justify-between gap-3 px-4 pb-2 pr-3 pt-4">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-medium leading-[21px] text-foreground"
            title={currentQuestion.question}
          >
            {currentQuestion.question}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs leading-[18px] text-muted-foreground">
          <span className="rounded-[var(--piwork-control-radius)] bg-muted px-2 py-0.5 [corner-shape:superellipse(1.5)]">
            {currentQuestion.allowMultiple
              ? uiCopy.permission.askUser.multipleChoice
              : uiCopy.permission.askUser.singleChoice}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 py-1">
        <div
          className="flex flex-col gap-1 px-2"
          role={currentQuestion.allowMultiple ? "group" : "radiogroup"}
        >
          {currentQuestion.options.map((option, index) => {
            const checked = currentAnswer.selectedOptionIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                role={currentQuestion.allowMultiple ? "checkbox" : "radio"}
                aria-checked={checked}
                onClick={() => toggleOption(option.id)}
                className={`${optionButtonClass} ${
                  checked
                    ? "bg-muted/80 text-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-accent/55 hover:text-foreground"
                }`}
              >
                <span className="w-4 shrink-0 text-left text-muted-foreground">{index + 1}.</span>
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="min-w-0 truncate text-foreground overflow-visible">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="ml-auto max-w-[50%] shrink-0 truncate text-right text-xs leading-[17px] text-muted-foreground opacity-0 group-hover/ask-option:opacity-100 group-focus-visible/ask-option:opacity-100">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {currentQuestion.allowFreeText && (
            <label
              className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] p-2 text-left text-[13px] font-normal leading-[18px] text-muted-foreground transition-colors focus-within:bg-muted/55 hover:bg-accent/55 [corner-shape:superellipse(1.5)] ${
                currentAnswer.freeText.trim() ? "bg-muted/80 text-foreground" : "bg-transparent"
              }`}
            >
              <span className="w-4 shrink-0 text-left text-muted-foreground">
                {currentQuestion.options.length + 1}.
              </span>
              <textarea
                value={currentAnswer.freeText}
                disabled={disabled}
                onChange={(event) => updateFreeText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    advanceOrSubmit();
                  }
                }}
                rows={1}
                placeholder={uiCopy.permission.askUser.customAnswer}
                aria-label={uiCopy.interaction.freeTextLabel}
                className="h-5 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
          )}
        </div>

        <div className="relative flex h-9 items-center justify-between gap-2 px-4 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {questions.length > 1 && (
              <button
                type="button"
                aria-label={uiCopy.permission.askUser.previousQuestion}
                onClick={() => setActiveQuestion((value) => Math.max(0, value - 1))}
                disabled={disabled || safeActiveQuestion === 0}
                className={askSecondaryButtonClass}
              >
                {uiCopy.permission.askUser.previous}
              </button>
            )}
            {error && (
              <p className="min-w-0 truncate text-xs leading-4 text-danger overflow-visible">
                {error}
              </p>
            )}
          </div>
          {questions.length > 1 && (
            <span
              data-testid="ask-question-progress"
              className="pointer-events-none absolute bottom-2 left-1/2 min-w-[42px] -translate-x-1/2 text-center text-xs leading-5 text-muted-foreground"
            >
              {safeActiveQuestion + 1} / {questions.length}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSubmit({ requestId: request.id, kind: "ask", status: "cancelled" })}
              aria-label={uiCopy.permission.askUser.interruptQuestion}
              className="flex h-7 items-center gap-1 rounded-[var(--piwork-control-radius)] border border-transparent px-2 py-0 text-[13px] leading-[18px] text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{uiCopy.common.dismiss}</span>
              <span className="rounded-md bg-muted px-1.5 py-0 text-muted-foreground">ESC</span>
            </button>
            {!isLastQuestion ? (
              <button
                type="button"
                aria-label={uiCopy.permission.askUser.nextQuestion}
                onClick={advanceOrSubmit}
                disabled={disabled || !currentQuestionAnswered}
                className={askPrimaryButtonClass}
              >
                {uiCopy.permission.askUser.next}
              </button>
            ) : (
              <button
                type="button"
                disabled={disabled || !allQuestionsAnswered}
                onClick={submitAnswers}
                className={`${askPrimaryButtonClass} gap-1 px-2`}
              >
                <span>{uiCopy.permission.submit}</span>
                <kbd
                  aria-hidden="true"
                  className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border-0 bg-current/10 px-1.5 py-0 font-sans text-xs leading-4 text-current [corner-shape:superellipse(1.5)]"
                >
                  ⏎
                </kbd>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PlanInteraction({
  request,
  disabled,
  error,
  onSubmit,
}: {
  request: ProposePlanInteractionRequest;
  disabled: boolean;
  error: string;
  onSubmit: (response: InteractionResponse) => boolean;
}) {
  const [refinement, setRefinement] = useState("");
  const trimmedRefinement = refinement.trim();
  const title = request.title || uiCopy.interaction.planTitle;

  const submitDecision = (decision: "execute" | "continue_planning" | "refine") => {
    onSubmit({
      requestId: request.id,
      kind: "propose_plan",
      status: "submitted",
      decision,
      refinement: decision === "refine" ? trimmedRefinement : undefined,
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || disabled) return;
      event.preventDefault();
      onSubmit({ requestId: request.id, kind: "propose_plan", status: "cancelled" });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onSubmit, request.id]);

  const submitInstruction = () =>
    submitDecision(trimmedRefinement ? "refine" : "continue_planning");

  return (
    <section
      aria-label={title}
      className="flex min-h-[126px] shrink-0 flex-col overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border/80 bg-card text-foreground [corner-shape:superellipse(1.5)]"
    >
      <div className="flex h-11 items-start justify-between px-4 pb-2 pr-3 pt-4">
        <div className="text-sm font-medium leading-[21px] text-foreground">
          {uiCopy.permission.exitPlan.implementTitle}
        </div>
      </div>

      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1 px-2">
          <button
            type="button"
            onClick={() => submitDecision("execute")}
            disabled={disabled}
            className="flex h-8 w-full items-center gap-1 rounded-[var(--piwork-control-radius)] bg-muted/70 p-2 text-left text-[13px] font-normal leading-[18px] text-foreground outline-none transition-colors hover:bg-accent/70 disabled:cursor-not-allowed disabled:opacity-50 [corner-shape:superellipse(1.5)]"
          >
            <span className="w-4 shrink-0 text-left text-muted-foreground">1.</span>
            <span className="min-w-0 flex-1 truncate">
              {uiCopy.permission.exitPlan.implementAction}
            </span>
          </button>

          <div className="-mt-1 flex min-h-9 items-center justify-between gap-2 px-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-[13px] leading-5 text-muted-foreground">
              <span className="min-w-[1.5ch] shrink-0 text-left">2.</span>
              <textarea
                value={refinement}
                onChange={(event) => setRefinement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitInstruction();
                  }
                }}
                disabled={disabled}
                rows={1}
                aria-label={uiCopy.interaction.refinementLabel}
                className="h-5 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                placeholder={uiCopy.permission.exitPlan.adjustPlaceholder}
              />
            </label>
            <div className="flex shrink-0 items-center gap-2 py-1">
              <button
                type="button"
                onClick={() =>
                  onSubmit({
                    requestId: request.id,
                    kind: "propose_plan",
                    status: "cancelled",
                  })
                }
                disabled={disabled}
                className="flex h-8 items-center gap-1 rounded-[var(--piwork-control-radius)] border border-transparent px-2 text-[13px] leading-[18px] text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{uiCopy.common.dismiss}</span>
                <span className="rounded-md bg-muted px-1.5 py-0 text-muted-foreground">ESC</span>
              </button>
              <button
                type="button"
                onClick={submitInstruction}
                disabled={disabled}
                className="flex h-8 items-center gap-1 rounded-[var(--piwork-control-radius)] border border-transparent bg-primary px-2 py-0 text-[13px] leading-[18px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-medium">{uiCopy.permission.submit}</span>
                <kbd
                  aria-hidden="true"
                  className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border-0 bg-current/10 px-1.5 py-0 font-sans text-xs leading-4 text-current [corner-shape:superellipse(1.5)]"
                >
                  ⏎
                </kbd>
              </button>
            </div>
          </div>
          {error && <p className="px-2 pb-2 text-xs leading-4 text-danger">{error}</p>}
        </div>
      </div>
    </section>
  );
}
