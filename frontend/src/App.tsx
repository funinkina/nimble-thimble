import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { chatAdapter } from "./runtime";
import { ChatPane } from "./components/ChatPane";
import { MemoryPanel } from "./components/MemoryPanel";
import { InspectorPane } from "./components/InspectorPane";

export default function App() {
  const runtime = useLocalRuntime(chatAdapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app">
        <ChatPane />
        <MemoryPanel />
        <InspectorPane />
      </div>
    </AssistantRuntimeProvider>
  );
}
