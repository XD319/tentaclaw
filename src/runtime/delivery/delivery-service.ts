import type { InboxDeliveryEvent, InboxListQuery } from "../../types/index.js";

export type InboxDeliveryListener = (event: InboxDeliveryEvent) => void;

interface Subscription {
  filter: InboxListQuery;
  listener: InboxDeliveryListener;
}

const INTERNAL_PRODUCER_KEY = Symbol("internal_delivery_producer");

export interface DeliveryProducer {
  publish(key: symbol, event: InboxDeliveryEvent): void;
}

export class DeliveryService {
  private readonly subscriptions = new Set<Subscription>();

  public createProducer(): DeliveryProducer {
    return {
      publish: (key, event) => {
        if (key !== INTERNAL_PRODUCER_KEY) {
          throw new Error("Unauthorized delivery producer.");
        }
        this.publish(event);
      }
    };
  }

  public producerKey(): symbol {
    return INTERNAL_PRODUCER_KEY;
  }

  public subscribe(filter: InboxListQuery, listener: InboxDeliveryListener): () => void {
    const subscription: Subscription = { filter, listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  private publish(event: InboxDeliveryEvent): void {
    for (const subscription of this.subscriptions) {
      if (!matchesFilter(event, subscription.filter)) {
        continue;
      }
      subscription.listener(event);
    }
  }
}

function matchesFilter(event: InboxDeliveryEvent, filter: InboxListQuery): boolean {
  const item = event.item;
  if (filter.userId !== undefined && item.userId !== filter.userId) {
    return false;
  }
  if (filter.taskId !== undefined && item.taskId !== filter.taskId) {
    return false;
  }
  if (filter.threadId !== undefined && item.threadId !== filter.threadId) {
    return false;
  }
  if (filter.category !== undefined && item.category !== filter.category) {
    return false;
  }
  if (filter.status !== undefined && item.status !== filter.status) {
    return false;
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0 && !filter.statuses.includes(item.status)) {
    return false;
  }
  return true;
}
