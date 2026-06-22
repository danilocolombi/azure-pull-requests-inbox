import { getPollSeconds } from '../state/config';
import { PrTreeProvider } from '../view/prTreeProvider';

/**
 * Drives the single polling interval. Pull requests change far slower than pipeline logs,
 * so unlike the Pipelines sibling there is nothing to "tail" — the loop simply re-fetches
 * the inbox while the view is visible, so a PR that lands in your review queue (or a vote on
 * your own PR) shows up on its own. It stops itself when the view is hidden, and re-arms via
 * `setVisible(true)`.
 */
const TICK_WATCHDOG_MS = 90000;

export class PollController {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickStartedAt = 0;
  private visible = false;

  constructor(private readonly provider: PrTreeProvider) {}

  /** Track inbox visibility; while visible, keep polling to discover new pull requests. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.ensureRunning();
      void this.tick(); // refresh now, even if the timer was already ticking
    }
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), getPollSeconds() * 1000);
    void this.tick();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Apply a changed poll interval by restarting the timer if it's running. */
  restart(): void {
    if (!this.timer) return;
    this.stop();
    this.ensureRunning();
  }

  private async tick(): Promise<void> {
    if (this.ticking && Date.now() - this.tickStartedAt < TICK_WATCHDOG_MS) return;
    if (!this.visible) {
      this.stop();
      return;
    }
    this.ticking = true;
    this.tickStartedAt = Date.now();
    try {
      await this.provider.refreshData();
    } catch {
      // Swallow transient errors; keep the loop alive for the next tick.
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    this.stop();
  }
}
