import { createContext, useContext } from "react";

/** Sends text into the chat as the user's next message. Null where there is no chat (boards), so actions render disabled. */
export type CanvasAction = ((text: string) => void) | null;

const CanvasActionContext = createContext<CanvasAction>(null);

export const CanvasActionProvider = CanvasActionContext.Provider;
export const useCanvasAction = () => useContext(CanvasActionContext);

/** True once the conversation has moved on (a later user message exists): old decision cards stay readable but stop accepting clicks. Survives reloads, unlike component state. */
const CanvasLockContext = createContext(false);

export const CanvasLockProvider = CanvasLockContext.Provider;
export const useCanvasLocked = () => useContext(CanvasLockContext);
