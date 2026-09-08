import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';

/** Used by the chat transcript to separate queued input from confirmed Claude consumption. */
export function MessageDeliveryStatus({ message, onDismiss, onRetry }: { message: ChatMessage; onDismiss?: () => void; onRetry?: () => void }) {
  const { t } = useTranslation('chat');
  if (!message.delivery) return null;
  return <><span role="status" title={message.deliveryError} className={message.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
    {t(`message.delivery.${message.delivery}`, { defaultValue: { queued: 'Waiting to be processed', delivered: 'Delivered', failed: 'Delivery unconfirmed' }[message.delivery] })}
  </span>{message.delivery === 'failed' && (message.retriedAsClientMessageId
    ? <span className="ml-1 text-muted-foreground" title={t('message.delivery.retriedHint', { defaultValue: 'Follow the new message below for delivery status. This original copy will not be retried again.' })}>{t('message.delivery.retried', { defaultValue: 'Retried as a new message' })}</span>
    : onRetry && <button type="button" onClick={onRetry} className="ml-1 rounded px-1 hover:bg-muted" title={t('message.delivery.retryHint', { defaultValue: 'Delivery was not confirmed. Review the conversation first; retrying sends a new message.' })}>{t('message.delivery.retry', { defaultValue: 'Retry as new message' })}</button>)}{onDismiss && message.clientMessageId && <button type="button" onClick={onDismiss}
    className="ml-1 rounded px-1 hover:bg-muted" title={t('message.delivery.dismissHint')} aria-label={t('message.delivery.dismiss')}>
    {t('message.delivery.dismiss')}
  </button>}</>;
}
