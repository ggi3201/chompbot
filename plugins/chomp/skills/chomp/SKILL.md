---
name: chomp
description: Talk to Chomp, the user's personal assistant on their home server, through the chomp MCP tools. Use when the task says Chomp sent it, when you need something Chomp knows (the user's memories, a past chat), or to hand Chomp work it does better.
---

# Chomp

Chomp is the user's assistant. It runs on their home server, has their memories, and keeps one
agent per chat. These tools reach it from outside: read its chats and memories, and talk to its chats.

## When Chomp started you

A task that says "You were started by Chomp chat <id>" came from that chat's agent.
- **Ask it** when a decision is the user's or needs context you lack: `message_chat` with that id and
  `wait: true` returns the answer.
- **Report back** when you finish or get stuck: `message_chat` with that id, without `wait`, saying what
  you did (a PR URL, a failure and why). That wakes the chat, so its agent can review and merge.
- Keep it to one message per real event. Each chat takes 5 agent messages per 10 minutes.

## Getting answers

Every `message_chat` and `start_chat` result carries a reply ticket (`<chat id>@<time>`) unless it already
holds the answer. When you did not wait, the wait ran out, or Chomp restarted, `get_reply` with that ticket
returns `working` or `answered` and the text: the answer is kept in the chat, so it is never lost. With the
`chomp-replies.py` hook installed (it is on the Mac), you need not poll: answers arrive by themselves on your
next tool call or prompt, or before you stop. Do not poll get_reply in a loop; use `wait: true` once instead.

Lost the ticket, or started a new session? `my_chats` lists the chats you started or messaged, newest
first, with a fresh ticket for each. Pass `from` (part of your session label, such as the worktree) to see
only that session's chats.

## Reading

- `list_conversations` and `search_conversations` find chats. `get_conversation_messages` reads one.
- `recall_memories` searches what Chomp knows about the user, `save_memory` adds to it. Recall before asking
  the user something Chomp may already know.

## Handing Chomp work

`start_chat` opens a new chat with a task. With `project` (a repo folder name on Chomp's server, like `chomp`)
its agent works in that repo, in its own git worktree. The chat appears in Chomp for the user to follow.

## Saying who you are

`message_chat` and `start_chat` need `from`: your working folder and task in a few words, e.g.
"chomp worktree preview-pane: PiP window". The user runs several sessions at once, and this is how they and
the chat's agent tell which one wrote. Every result names the chat that got your message and links to it:
pass that link on to the user, so they can open the chat.

## Rules

- Messages show in the chat as "From <your token's name> (<from>), outside Chomp". Write them self-contained: the
  other agent has not seen your session.
- The other agent acts with the access the user gave that chat. Do not use Chomp to do things the user
  has not asked for.
