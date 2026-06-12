import type {
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TranscriptEntry } from '../types';
import type { SessionEventHost } from './session-event-handler';

export class BackgroundTaskController {
  readonly backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  readonly backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  constructor(private readonly host: SessionEventHost) {}

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
  }

  handleEvent(event: BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent): void {
    const { state } = this.host;
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'timed_out' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      if (info.kind === 'agent') {
        this.syncBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendTranscriptEntry(info);
      this.syncBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (info.kind === 'agent') {
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === 'process' || info.kind === 'question') {
          this.appendTranscriptEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendTranscriptEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  syncBadge(): void {
    // The footer now reads background-task counts from the live status
    // snapshot, so we only need to request a re-render.
    this.host.state.ui.requestRender();
  }
}
