/**
 * The command log: every byte sent to and received from the instrument.
 *
 * This is deliberately prominent rather than tucked into a debug panel. For a
 * student, watching `bf100000` go out as they drag the frequency slider is the
 * moment the abstraction becomes concrete - it is the teaching content, not
 * diagnostics.
 */

export type LogKind = 'tx' | 'rx' | 'info' | 'error';

const MAX_ROWS = 300;

export class CommandLog {
  private rows = 0;

  constructor(private container: HTMLElement) {}

  add(kind: LogKind, text: string): void {
    const row = document.createElement('div');
    row.className = `log-row log-${kind}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });

    const arrow = document.createElement('span');
    arrow.className = 'log-arrow';
    arrow.textContent = kind === 'tx' ? '>>' : kind === 'rx' ? '<<' : kind === 'error' ? '!!' : '--';

    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;

    row.append(time, arrow, body);
    this.container.append(row);
    this.rows++;

    // Keep the DOM bounded; a long lab session would otherwise grow forever.
    while (this.rows > MAX_ROWS && this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
      this.rows--;
    }

    this.container.scrollTop = this.container.scrollHeight;
  }

  clear(): void {
    this.container.replaceChildren();
    this.rows = 0;
  }
}
