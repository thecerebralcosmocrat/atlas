import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

const suggestions = [
  "What does this repo do?",
  "How do I run this?",
  "What should I read first?",
];

function Message({ role, content }) {
  const isUser = role === "user";

  return (
    <div
      className={
        isUser
          ? "border-s-2 border-primary bg-muted/40 px-4 py-3"
          : "border-s-2 border-transparent px-4 py-3"
      }
    >
      <div
        className={`text-[11px] font-medium uppercase tracking-widest ${
          isUser ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {isUser ? "You" : "Atlas"}
      </div>
      <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {content}
      </div>
    </div>
  );
}

export default function RepositoryChat({ repository, onAskRepository }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [isAsking, setIsAsking] = useState(false);
  const messagesRef = useRef(null);

  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content:
          "Ask me onboarding questions about this codebase. I can help with the project overview, run commands, structure, and where to start reading.",
      },
    ]);
    setQuestion("");
    setIsAsking(false);
  }, [repository?.id]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, isAsking]);

  const askQuestion = async (nextQuestion = question) => {
    const trimmedQuestion = nextQuestion.trim();

    if (!trimmedQuestion || isAsking) return;

    setQuestion("");
    setIsAsking(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", content: trimmedQuestion },
    ]);

    try {
      const answer = await onAskRepository(repository.id, trimmedQuestion);

      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", content: answer },
      ]);
    } catch (err) {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          role: "assistant",
          content:
            err.message || "I could not answer that yet. Try another question.",
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Ask</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Answers are grounded in the indexed source.
        </p>
      </div>

      <div
        ref={messagesRef}
        className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto"
      >
        {messages.map((message, index) => (
          <Message key={`${message.role}-${index}`} {...message} />
        ))}
        {isAsking && <Message role="assistant" content="Thinking…" />}
      </div>

      {messages.length <= 1 && (
        <div className="grid shrink-0 grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {suggestions.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => askQuestion(prompt)}
              className="px-3 py-2 text-start text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-stretch border-t border-border">
        <label htmlFor="repo-question" className="sr-only">
          Ask a question
        </label>
        <input
          id="repo-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") askQuestion();
          }}
          placeholder="Ask anything about this codebase"
          className="min-w-0 flex-1 bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          disabled={isAsking}
        />
        <button
          type="button"
          onClick={() => askQuestion()}
          disabled={isAsking || !question.trim()}
          aria-label="Send question"
          className="flex items-center justify-center border-s border-border px-4 text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </section>
  );
}
