import { useCallback, useEffect, useRef, useState } from "react";

// Chat history lives here, in a component that is never unmounted, rather than
// inside RepositoryChat. The Ask tab is unmounted whenever the user opens
// another tab or page, and state held there is thrown away with it.
//
// Each repository has its own conversation, so switching repositories no
// longer clears it either. A conversation belongs to the profile it was held
// in: `reset` drops everything when the profile changes.

export const GREETING = {
  role: "assistant",
  content:
    "Ask me onboarding questions about this codebase. I can help with the project overview, run commands, structure, and where to start reading.",
};

const EMPTY_CHAT = Object.freeze({
  messages: [GREETING],
  isAsking: false,
  streamingReply: "",
  draft: "",
});

export function useRepositoryChats(askRepository, stopAsk) {
  const [chats, setChats] = useState({});
  // The latest ask function, so an in-flight question never calls a stale one.
  const askRef = useRef(askRepository);
  const stopRef = useRef(stopAsk);
  // The request id of each question in flight, so it can be stopped.
  const requestIdsRef = useRef(new Map());
  // Repositories with a question in flight, checked synchronously so a fast
  // double submit cannot send the same question twice.
  const inFlightRef = useRef(new Set());
  // Bumped by `reset`, so an answer that arrives after a profile switch is
  // discarded instead of landing in another profile's conversation.
  const generationRef = useRef(0);

  useEffect(() => {
    askRef.current = askRepository;
    stopRef.current = stopAsk;
  }, [askRepository, stopAsk]);

  const update = useCallback((repositoryId, change, { create = true } = {}) => {
    setChats((current) => {
      const existing = current[repositoryId];

      if (!existing && !create) return current;

      const previous = existing ?? EMPTY_CHAT;

      return { ...current, [repositoryId]: { ...previous, ...change(previous) } };
    });
  }, []);

  const get = (repositoryId) => chats[repositoryId] ?? EMPTY_CHAT;

  const setDraft = useCallback(
    (repositoryId, draft) => update(repositoryId, () => ({ draft })),
    [update],
  );

  const ask = useCallback(
    async (repositoryId, question) => {
      const trimmedQuestion = String(question ?? "").trim();

      if (!trimmedQuestion || inFlightRef.current.has(repositoryId)) return;

      const generation = generationRef.current;

      inFlightRef.current.add(repositoryId);
      update(repositoryId, (previous) => ({
        messages: [...previous.messages, { role: "user", content: trimmedQuestion }],
        isAsking: true,
        streamingReply: "",
        draft: "",
      }));

      let reply;
      // Shows the answer as it streams in. Dropped after a profile switch or
      // once the conversation is gone, like the final answer below.
      const onText = (text) => {
        if (generation !== generationRef.current) return;
        update(repositoryId, () => ({ streamingReply: text }), { create: false });
      };

      try {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        requestIdsRef.current.set(repositoryId, requestId);
        reply = await askRef.current(repositoryId, trimmedQuestion, onText, requestId);
      } catch (error) {
        reply =
          error?.message || "I could not answer that yet. Try another question.";
      }

      inFlightRef.current.delete(repositoryId);
      requestIdsRef.current.delete(repositoryId);

      if (generation !== generationRef.current) return;

      // `create: false` drops the answer if the conversation was removed while
      // the question was in flight (the repository was deleted).
      update(
        repositoryId,
        (previous) => ({
          messages: [...previous.messages, { role: "assistant", content: reply }],
          isAsking: false,
          streamingReply: "",
        }),
        { create: false },
      );
    },
    [update],
  );

  // Stops the answer being written; what already arrived stays in the thread.
  const stop = useCallback((repositoryId) => {
    const requestId = requestIdsRef.current.get(repositoryId);

    if (requestId) stopRef.current?.(requestId);
  }, []);

  const remove = useCallback((repositoryId) => {
    inFlightRef.current.delete(repositoryId);
    setChats((current) => {
      if (!(repositoryId in current)) return current;

      const { [repositoryId]: _removed, ...rest } = current;

      return rest;
    });
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    setChats({});
  }, []);

  return { get, setDraft, ask, stop, remove, reset };
}
