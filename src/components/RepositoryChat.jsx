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
      layout="rows"
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
function Composer({ composer, repository, chat, onDraftChange, onAsk }) {
  const { snap } = useConversation();
  const { isAsking, streamingReply, draft } = chat;
  const status = !isAsking ? "ready" : streamingReply ? "streaming" : "submitted";

  return (
    <div
      className="shrink-0 pt-3"
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
        defaultValue={draft}
        onValueChange={(value) => onDraftChange(repository.id, value.text)}
        onSubmit={(value) => {
          onAsk(repository.id, value.text);
          snap();
        }}
        status={status}
        label="Ask a question"
        placeholder="Ask anything about this codebase"
      />
    </div>
  );
}

export default function RepositoryChat({
  repository,
  chat,
  onDraftChange,
  onAsk,
}) {
  // The conversation is owned by the app (see useRepositoryChats) so it
  // survives this tab being unmounted; this component only renders it.
  const { messages, isAsking, streamingReply } = chat;
  const status = isAsking ? "streaming" : "idle";
  const composer = useRef(null);

  return (
    <ConversationProvider status={status}>
      <section className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="shrink-0 pb-3">
          <h2 className="type-heading-sm text-text-1">Ask</h2>
          <p className="mt-1 type-body-sm text-text-2">
            Answers are grounded in the indexed source.
          </p>
        </div>

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
              {messages.length <= 1 && (
                <Suggestions
                  disabled={isAsking}
                  onSelect={(prompt) => {
                    // The question goes out as written; the unsent draft is dropped.
                    composer.current?.clear();
                    onAsk(repository.id, prompt);
                  }}
                />
              )}
            </ConversationContent>
          </ConversationViewport>
          <ConversationJump />
        </Conversation>

        <Composer
          composer={composer}
          repository={repository}
          chat={chat}
          onDraftChange={onDraftChange}
          onAsk={onAsk}
        />
      </section>
    </ConversationProvider>
  );
}
