import { useNavigate } from "react-router-dom";
import FilesPanel from "../components/chat/FilesPanel";
import { useIsMobile } from "../hooks/useIsMobile";

/** The server's files, not tied to a project: the home folder, minus credential stores and env files. */
export default function Files() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // A prompt link opens a chat with the file's absolute path in the composer, ready to ask about.
  const addToChat = (path: string) => navigate(`/chat?prompt=${encodeURIComponent(`\`${path}\` `)}`);
  return (
    <div className="h-full min-h-0">
      <FilesPanel source={{ scope: "server" }} title="Home" titleHint="The server's home folder" layout="page" isMobile={isMobile} onAddToChat={addToChat} />
    </div>
  );
}
