import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';

/** Used by the chat transcript to separate queued input from confirmed Claude consumption. */
export function MessageDeliveryStatus({ message, onDismiss, onRetry }: { message: ChatMessage; onDismiss?: () => void; onRetry?: () => void }) {
  const { t } = useTranslation('chat');
  if (!message.delivery) return null;
  const notSubmitted = message.delivery === 'failed' && message.definitelyNotSubmitted === true;
  return <><span role="status" title={message.deliveryError} className={message.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
    {notSubmitted ? t('message.delivery.notSubmitted', { defaultValue: 'Not submitted' }) : t(`message.delivery.${message.delivery}`, { defaultValue: { queued: 'Waiting to be processed', delivered: 'Delivered', failed: 'Delivery unconfirmed' }[message.delivery] })}
  </span>{message.delivery === 'failed' && (message.retriedAsClientMessageId
    ? <span className="ml-1 text-muted-foreground" title={t('message.delivery.retriedHint', { defaultValue: 'Follow the new message below for delivery status. This original copy will not be retried again.' })}>{t('message.delivery.retried', { defaultValue: 'Retried as a new message' })}</span>
    : onRetry && <button type="button" onClick={onRetry} className="ml-1 rounded px-1 hover:bg-muted" title={notSubmitted ? t('message.delivery.notSubmittedHint', { defaultValue: 'The remote did not accept this message. Send this saved text and its attachments when input is available.' }) : t('message.delivery.retryHint', { defaultValue: 'Delivery was not confirmed. Review the conversation first; retrying sends a new message.' })}>{notSubmitted ? t('message.delivery.sendSaved', { defaultValue: 'Send saved message' }) : t('message.delivery.retry', { defaultValue: 'Retry as new message' })}</button>)}{onDismiss && message.clientMessageId && <button type="button" onClick={onDismiss}
    className="ml-1 rounded px-1 hover:bg-muted" title={t('message.delivery.dismissHint')} aria-label={t('message.delivery.dismiss')}>
    {t('message.delivery.dismiss')}
  </button>}</>;
}
