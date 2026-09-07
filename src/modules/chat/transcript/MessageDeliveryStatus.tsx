import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';

/** Used by the chat transcript to separate queued input from confirmed Claude consumption. */
export function MessageDeliveryStatus({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat');
  if (!message.delivery) return null;
  return <span role="status" title={message.deliveryError} className={message.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
    {t(`message.delivery.${message.delivery}`, { defaultValue: { queued: 'Waiting to be processed', delivered: 'Delivered', failed: 'Delivery unconfirmed' }[message.delivery] })}
  </span>;
}
