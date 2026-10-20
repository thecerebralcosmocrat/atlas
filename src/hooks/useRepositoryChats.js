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
  draft: "",
});

export function useRepositoryChats(askRepository) {
  const [chats, setChats] = useState({});
  // The latest ask function, so an in-flight question never calls a stale one.
  const askRef = useRef(askRepository);
  // Repositories with a question in flight, checked synchronously so a fast
  // double submit cannot send the same question twice.
  const inFlightRef = useRef(new Set());
  // Bumped by `reset`, so an answer that arrives after a profile switch is
  // discarded instead of landing in another profile's conversation.
  const generationRef = useRef(0);

  useEffect(() => {
    askRef.current = askRepository;
  }, [askRepository]);

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
        draft: "",
      }));

      let reply;

      try {
        reply = await askRef.current(repositoryId, trimmedQuestion);
      } catch (error) {
        reply =
          error?.message || "I could not answer that yet. Try another question.";
      }

      inFlightRef.current.delete(repositoryId);

      if (generation !== generationRef.current) return;

      // `create: false` drops the answer if the conversation was removed while
      // the question was in flight (the repository was deleted).
      update(
        repositoryId,
        (previous) => ({
          messages: [...previous.messages, { role: "assistant", content: reply }],
          isAsking: false,
        }),
        { create: false },
      );
    },
    [update],
  );

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

  return { get, setDraft, ask, remove, reset };
}
