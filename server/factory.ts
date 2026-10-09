/** Owns one coordinator per project and routes card work to the right one. */
import * as db from './db.ts';
import { Coordinator, HttpError } from './coordinator.ts';
import { getProject, listProjects } from './settings.ts';
import type { Driver } from './agents/driver.ts';

export class Factory {
  private coordinators = new Map<number, Coordinator>();
  private driverFor: (projectId: number) => Driver;
  private started = false;
  private stopped = false;

  constructor(driverFor: (projectId: number) => Driver) {
    this.driverFor = driverFor;
  }

  start(): void {
    this.started = true;
    for (const project of listProjects()) this.coordinator(project.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.coordinators.values()].map((c) => c.stop()));
  }

  /** The project's coordinator, started on first use (e.g. right after the project is created). */
  coordinator(projectId: number): Coordinator {
    const existing = this.coordinators.get(projectId);
    if (existing) return existing;
    if (!getProject(projectId)) throw new HttpError(404, `Project ${projectId} not found`);
    if (this.stopped) throw new HttpError(409, 'The factory is shutting down');
    const coordinator = new Coordinator(projectId, () => this.driverFor(projectId));
    this.coordinators.set(projectId, coordinator);
    if (this.started) coordinator.start();
    return coordinator;
  }

  /** The coordinator that owns a card. */
  forCard(cardId: number): Coordinator {
    const card = db.getCard(cardId);
    if (!card) throw new HttpError(404, `Card #${cardId} not found`);
    return this.coordinator(card.projectId);
  }

  driver(projectId: number): Driver {
    return this.driverFor(projectId);
  }
}
