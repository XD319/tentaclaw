import type { TraceService } from "../../tracing/trace-service.js";
import type {
  InboxDeliveryEvent,
  InboxItem,
  InboxItemDraft,
  InboxListQuery,
  InboxRepository
} from "../../types/index.js";

import type { DeliveryProducer, DeliveryService } from "../delivery/delivery-service.js";

export interface InboxServiceDependencies {
  deliveryService: DeliveryService;
  deliveryProducer: DeliveryProducer;
  deliveryProducerKey: symbol;
  inboxRepository: InboxRepository;
  traceService: TraceService;
}

export class InboxService {
  public constructor(private readonly dependencies: InboxServiceDependencies) {}

  public append(record: InboxItemDraft): InboxItem {
    const existing =
      record.dedupKey === undefined || record.dedupKey === null
        ? null
        : this.dependencies.inboxRepository.findByDedup({
            dedupKey: record.dedupKey,
            userId: record.userId
          });
    const item = existing ?? this.dependencies.inboxRepository.create(record);
    if (existing === null) {
      this.dependencies.traceService.record({
        actor: "inbox.service",
        eventType: "inbox_item_created",
        payload: {
          category: item.category,
          inboxId: item.inboxId,
          status: item.status,
          taskId: item.taskId,
          userId: item.userId
        },
        stage: "completion",
        summary: `Inbox item created: ${item.category}`,
        taskId: item.taskId ?? "inbox"
      });
      this.publish({
        item,
        kind: "created"
      });
    }
    return item;
  }

  public list(query: InboxListQuery = {}): InboxItem[] {
    return this.dependencies.inboxRepository.list(query);
  }

  public get(inboxId: string): InboxItem | null {
    return this.dependencies.inboxRepository.findById(inboxId);
  }

  public markDone(inboxId: string, reviewerId: string): InboxItem {
    const doneAt = new Date().toISOString();
    const item = this.dependencies.inboxRepository.update(inboxId, {
      doneAt,
      status: "done"
    });
    this.dependencies.traceService.record({
      actor: "inbox.service",
      eventType: "inbox_item_done",
      payload: {
        inboxId: item.inboxId,
        reviewerId,
        status: item.status,
        userId: item.userId
      },
      stage: "completion",
      summary: `Inbox item done: ${item.inboxId}`,
      taskId: item.taskId ?? "inbox"
    });
    this.publish({
      item,
      kind: "updated"
    });
    return item;
  }

  public markDismissed(inboxId: string): InboxItem {
    const item = this.dependencies.inboxRepository.update(inboxId, {
      status: "dismissed"
    });
    this.publish({
      item,
      kind: "updated"
    });
    return item;
  }

  public subscribe(filter: InboxListQuery, listener: (event: InboxDeliveryEvent) => void): () => void {
    return this.dependencies.deliveryService.subscribe(filter, listener);
  }

  private publish(event: InboxDeliveryEvent): void {
    this.dependencies.deliveryProducer.publish(this.dependencies.deliveryProducerKey, event);
  }
}
