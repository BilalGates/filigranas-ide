import { useState } from 'react';
import { cancelReview, type Review, type Proof } from './ipc';

export default function ApprovalForm({ review, action, onConfirm, onClose }: {
  review: Review;
  action: string;
  onConfirm: (proof: Proof) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="remote-review" aria-label="Aprobación de operación remota">
      <p>{review.message}</p>
      <label className="pub-field">
        <span>Escribe <code>{review.code}</code> para confirmar</span>
        <input aria-label="SHA de confirmación" value={typed} onChange={(event) => setTyped(event.target.value)}
          autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </label>
      <div className="co-actions">
        <button className="co-btn" onClick={() => cancelReview(review.id).then(onClose, (e) => setError(String(e)))}>cancelar</button>
        <button className="co-btn is-primary" disabled={typed.trim() !== review.code}
          onClick={() => onConfirm({ id: review.id, typed })}>{action}</button>
      </div>
      {error && <p className="co-error">{error}</p>}
    </div>
  );
}
