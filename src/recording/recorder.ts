// ============================================================
// ActionRecorder — Records MCP tool invocations for test generation
// ============================================================

export interface RecordedAction {
  timestamp: number;
  tool: string;
  params: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export class ActionRecorder {
  private actions: RecordedAction[] = [];
  private recording = false;
  private testName: string = "untitled";
  private startTime: number = 0;

  get isRecording(): boolean {
    return this.recording;
  }

  get actionCount(): number {
    return this.actions.length;
  }

  startRecording(testName?: string): void {
    this.actions = [];
    this.recording = true;
    this.testName = testName || `test_${Date.now()}`;
    this.startTime = Date.now();
  }

  stopRecording(): RecordedAction[] {
    this.recording = false;
    return [...this.actions];
  }

  recordAction(tool: string, params: Record<string, unknown>, result: string, durationMs: number): void {
    if (!this.recording) return;
    this.actions.push({
      timestamp: Date.now(),
      tool,
      params,
      result: result.substring(0, 500), // Truncate large results
      durationMs,
    });
  }

  getActions(): RecordedAction[] {
    return [...this.actions];
  }

  getTestName(): string {
    return this.testName;
  }
}
