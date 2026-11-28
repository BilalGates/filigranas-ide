import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationLog, Prose } from '../src/Conversation';

const root = createRoot(document.getElementById('root')!);
const durations: number[] = [];
Object.assign(window, {
  durations,
  showMessage: (text: string, streaming: boolean) => root.render(
    <Profiler id="message" onRender={(_id, _phase, duration) => durations.push(duration)}>
      <Prose text={text} streaming={streaming} />
    </Profiler>),
  showLog: () => root.render(<ConversationLog project="test" agent="Agente" onDiff={() => {}}
    items={[{ id: 'tool', type: 'mcpToolCall', tool: 'Investigar &amp;copy;', status: 'completed' }]}
    asks={[{ key: 'ask', title: 'Permiso pendiente', decide: () => {} }]} />),
  showStreamingLog: (text: string, streaming: boolean) => root.render(
    <div className="fixture-scroll">
      <ConversationLog project="test" agent="Agente" onDiff={() => {}} streaming={streaming}
        items={[{ id: 'answer', type: 'agentMessage', text }]} asks={[]} />
    </div>),
});
