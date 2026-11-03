import { useRef } from "react";
import { PromptInput } from "@/components/glaze/ai/prompt-input";
import {
  Conversation,
  ConversationProvider,
  ConversationViewport,
  ConversationContent,
  ConversationJump,
  useConversation,
} from "@/components/glaze/ai/conversation";
import {
  Message,
  MessageContent,
  MessageBubble,
  MessageBubbleContent,
  AgentTurn,
} from "@/components/glaze/ai/message";
import { Response } from "@/components/glaze/ai/response";
import { Activity } from "@/components/glaze/ai/activity";
import { FollowUps } from "@/components/glaze/ai/follow-ups";

const suggestions = [
  "What does this repo do?",
  "How do I run this?",
  "What should I read first?",
];

function Turn({ role, content }) {
  if (role === "user") {
    return (
      <Message from="user">
        <MessageContent>
          <MessageBubble>
            <MessageBubbleContent>{content}</MessageBubbleContent>
          </MessageBubble>
        </MessageContent>
      </Message>
    );
  }

  return (
    <AgentTurn name="Atlas" state="done">
      <Response>{content}</Response>
    </AgentTurn>
  );
}

function Suggestions({ disabled, onSelect }) {
  const { snap } = useConversation();

  return (
    <FollowUps
      layout="chips"
      suggestions={suggestions}
      disabled={disabled}
      onSelect={(prompt) => {
        onSelect(prompt);
        snap();
      }}
    />
  );
}

// The composer sits inside the provider so a send can snap the thread to the
// latest message, even when the person had scrolled up to read.
function Composer({ composer, repository, chat, onDraftChange, onAsk, onStop }) {
  const { snap } = useConversation();
  const { isAsking, streamingReply, draft } = chat;
  const status = !isAsking ? "ready" : streamingReply ? "streaming" : "submitted";

  return (
    <div
      className="shrink-0"
      // One question at a time: Enter does nothing while an answer is coming.
      onKeyDownCapture={(event) => {
        if (isAsking && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <PromptInput
        // A fresh composer per repository, seeded with that repository's draft.
        key={repository.id}
        ref={composer}
        layout="inline"
        defaultValue={draft}
        onValueChange={(value) => onDraftChange(repository.id, value.text)}
        onSubmit={(value) => {
          onAsk(repository.id, value.text);
          snap();
        }}
        status={status}
        onStop={() => onStop(repository.id)}
        label="Ask a question"
        placeholder={`Ask about ${repository.name}`}
      />
      <p className="mt-2 text-center type-caption text-text-3">
        Answers are grounded in the indexed source.
      </p>
    </div>
  );
}

export default function RepositoryChat({
  repository,
  chat,
  onDraftChange,
  onAsk,
  onStop,
}) {
  // The conversation is owned by the app (see useRepositoryChats) so it
  // survives this tab being unmounted; this component only renders it.
  const { messages, isAsking, streamingReply } = chat;
  const status = isAsking ? "streaming" : "idle";
  const composer = useRef(null);
  // Only the seeded greeting so far: show a welcome with the composer in the
  // middle of the page instead of an empty thread above a docked input.
  const isEmpty = messages.length <= 1 && !isAsking;

  const askSuggestion = (prompt) => {
    // The question goes out as written; the unsent draft is dropped.
    composer.current?.clear();
    onAsk(repository.id, prompt);
  };

  return (
    <ConversationProvider status={status}>
      <section
        className={`mx-auto flex h-full min-h-0 w-full max-w-measure flex-col ${
          isEmpty ? "justify-center gap-4" : "gap-3"
        }`}
      >
        {isEmpty ? (
          <div className="text-center">
            <h2 className="type-heading text-text-1">
              Ask about {repository.name}
            </h2>
            <p className="mt-1 type-body text-text-2">
              {messages[0]?.content}
            </p>
          </div>
        ) : (
          <Conversation status={status} className="min-h-0 flex-1">
            <ConversationViewport aria-label={`Ask ${repository.name}`}>
              <ConversationContent>
                {messages.map((message, index) => (
                  <Turn key={`${message.role}-${index}`} {...message} />
                ))}
                {isAsking && streamingReply && (
                  <AgentTurn name="Atlas" state="live">
                    <Response streaming>{streamingReply}</Response>
                  </AgentTurn>
                )}
                {isAsking && !streamingReply && (
                  <AgentTurn name="Atlas" state="live">
                    <Activity waiting announce={false} />
                  </AgentTurn>
                )}
              </ConversationContent>
            </ConversationViewport>
            <ConversationJump />
          </Conversation>
        )}

        <Composer
          composer={composer}
          repository={repository}
          chat={chat}
          onDraftChange={onDraftChange}
          onAsk={onAsk}
          onStop={onStop}
        />

        {isEmpty && (
          <div className="flex justify-center">
            <Suggestions disabled={isAsking} onSelect={askSuggestion} />
          </div>
        )}
      </section>
    </ConversationProvider>
  );
}
