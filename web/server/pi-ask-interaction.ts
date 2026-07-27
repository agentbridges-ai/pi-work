export const PI_ASK_BATCH_OPTION = "__piwork_ask_batch_v1__";

const ASK_BATCH_KIND = "piwork_ask_batch";
const ASK_BATCH_RESPONSE_KIND = "piwork_ask_batch_response";
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 4;

export interface PiAskQuestion {
  header: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
  multiSelect: boolean;
}

export interface PiAskAnswer {
  question: string;
  answer: string | string[];
}

export interface PiAskBatchRequest {
  toolCallId: string;
  questions: PiAskQuestion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function normalizeQuestion(value: unknown): PiAskQuestion | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.header) ||
    value.header.trim().length > 12 ||
    !nonEmptyString(value.question) ||
    value.question.trim().length > 4_096
  ) {
    return undefined;
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
    return undefined;
  }
  const options = value.options.flatMap((option) => {
    if (
      !isRecord(option) ||
      !nonEmptyString(option.label) ||
      option.label.trim().length > 1_024 ||
      !nonEmptyString(option.description) ||
      option.description.trim().length > 2_048
    ) {
      return [];
    }
    return [
      {
        label: option.label.trim(),
        description: option.description.trim(),
      },
    ];
  });
  if (
    options.length !== value.options.length ||
    new Set(options.map((option) => option.label)).size !== options.length
  ) {
    return undefined;
  }
  return {
    header: value.header.trim(),
    question: value.question.trim(),
    options,
    multiSelect: value.multiSelect === true,
  };
}

export function encodePiAskBatchTitle(
  toolCallId: string,
  questions: readonly PiAskQuestion[],
): string {
  const normalizedQuestions = questions.flatMap((question) => {
    const normalized = normalizeQuestion(question);
    return normalized ? [normalized] : [];
  });
  if (
    !nonEmptyString(toolCallId) ||
    questions.length < 1 ||
    questions.length > MAX_ASK_QUESTIONS ||
    normalizedQuestions.length !== questions.length
  ) {
    throw new Error("Ask questions are invalid.");
  }
  return JSON.stringify({
    kind: ASK_BATCH_KIND,
    version: 1,
    toolCallId: toolCallId.trim(),
    questions: normalizedQuestions,
  });
}

export function parsePiAskBatchRequest(
  title: unknown,
  options: unknown,
): PiAskBatchRequest | undefined {
  if (
    typeof title !== "string" ||
    !Array.isArray(options) ||
    options.length !== 1 ||
    options[0] !== PI_ASK_BATCH_OPTION
  ) {
    return undefined;
  }
  try {
    const payload = JSON.parse(title) as unknown;
    if (
      !isRecord(payload) ||
      payload.kind !== ASK_BATCH_KIND ||
      payload.version !== 1 ||
      !nonEmptyString(payload.toolCallId) ||
      !Array.isArray(payload.questions) ||
      payload.questions.length < 1 ||
      payload.questions.length > MAX_ASK_QUESTIONS
    ) {
      return undefined;
    }
    const questions = payload.questions.flatMap((question) => {
      const normalized = normalizeQuestion(question);
      return normalized ? [normalized] : [];
    });
    return questions.length === payload.questions.length
      ? { toolCallId: payload.toolCallId.trim(), questions }
      : undefined;
  } catch {
    return undefined;
  }
}

export function encodePiAskBatchResponse(answers: readonly PiAskAnswer[]): string {
  return JSON.stringify({
    kind: ASK_BATCH_RESPONSE_KIND,
    version: 1,
    answers,
  });
}

export function parsePiAskBatchResponse(
  value: unknown,
  questions: readonly PiAskQuestion[],
): PiAskAnswer[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const payload = JSON.parse(value) as unknown;
    if (
      !isRecord(payload) ||
      payload.kind !== ASK_BATCH_RESPONSE_KIND ||
      payload.version !== 1 ||
      !Array.isArray(payload.answers) ||
      payload.answers.length !== questions.length
    ) {
      return undefined;
    }
    const answers: PiAskAnswer[] = [];
    for (const [index, rawAnswer] of payload.answers.entries()) {
      if (!isRecord(rawAnswer) || rawAnswer.question !== questions[index]?.question) {
        return undefined;
      }
      const answer = rawAnswer.answer;
      if (typeof answer === "string") {
        if (questions[index]?.multiSelect || !nonEmptyString(answer)) return undefined;
        answers.push({ question: rawAnswer.question, answer: answer.trim() });
        continue;
      }
      if (
        !questions[index]?.multiSelect ||
        !Array.isArray(answer) ||
        answer.length === 0 ||
        answer.some((item) => !nonEmptyString(item))
      ) {
        return undefined;
      }
      answers.push({
        question: rawAnswer.question,
        answer: answer.map((item) => item.trim()),
      });
    }
    return answers;
  } catch {
    return undefined;
  }
}

export function buildPiAskReview(
  questions: readonly PiAskQuestion[],
  answers: readonly PiAskAnswer[],
) {
  const answersByQuestion = Object.fromEntries(
    answers.map(({ question, answer }) => [question, answer]),
  );
  return {
    kind: "ask_user_question_review" as const,
    answers: answersByQuestion,
    questions: questions.map(({ header, question }) => ({
      header,
      question,
      answer: answersByQuestion[question],
    })),
  };
}

export const PI_ASK_LIMITS = {
  questions: MAX_ASK_QUESTIONS,
  optionsPerQuestion: MAX_ASK_OPTIONS,
} as const;
