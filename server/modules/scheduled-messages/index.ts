// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from '@/modules/scheduled-messages/scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  // Session-actions integration tests exercise the real dispatcher against isolated rewind transactions.
  dispatchQueuedMessages,
  dispatchDueScheduledMessages,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
