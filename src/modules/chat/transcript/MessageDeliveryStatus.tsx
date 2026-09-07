import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';

/** Used by the chat transcript to separate queued input from confirmed Claude consumption. */
export function MessageDeliveryStatus({ message, onDismiss }: { message: ChatMessage; onDismiss?: () => void }) {
  const { t } = useTranslation('chat');
  if (!message.delivery) return null;
  return <><span role="status" title={message.deliveryError} className={message.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
    {t(`message.delivery.${message.delivery}`, { defaultValue: { queued: 'Waiting to be processed', delivered: 'Delivered', failed: 'Delivery unconfirmed' }[message.delivery] })}
  </span>{onDismiss && message.clientMessageId && <button type="button" onClick={onDismiss}
    className="ml-1 rounded px-1 hover:bg-muted" title={t('message.delivery.dismissHint')} aria-label={t('message.delivery.dismiss')}>
    {t('message.delivery.dismiss')}
  </button>}</>;
}
