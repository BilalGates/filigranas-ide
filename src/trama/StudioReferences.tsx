import { useEffect, useRef, useState } from 'react';
import { design, type DesignReference } from '../ipc';
import { Icon } from './icons';
import { Modal } from './ui';

const MAX_REFERENCES = 6;
const MAX_INCLUDED = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const imageUrl = (item: DesignReference) => `data:${item.mime};base64,${item.data}`;

async function referenceData(file: File) {
  if (file.size > MAX_BYTES) throw new Error('La referencia supera 2 MiB.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la referencia.'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = data;
  await image.decode().catch(() => { throw new Error('La referencia debe ser una imagen PNG, JPEG, WebP o GIF válida.'); });
  return data.split(',')[1];
}

export default function StudioReferences({ project, screen, included, onIncluded }: {
  project: string; screen: number; included: number[]; onIncluded: (ids: number[]) => void;
}) {
  const [items, setItems] = useState<DesignReference[] | null>(null);
  const [preview, setPreview] = useState<DesignReference | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    design.references(project, screen).then((items) => { if (active) setItems(items); },
      (error) => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [project, screen]);

  const update = async (operation: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setStatus('');
    try {
      await operation();
      const latest = await design.references(project, screen);
      setItems(latest);
      setStatus(message);
      return true;
    } catch (error) {
      setStatus(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return <section className="sec studio-references" aria-label="Referencias visuales">
    <div className="row">
      <h3 className="lab grow">Referencias visuales</h3>
      <button className="btn sm" disabled={busy || !items || items.length >= MAX_REFERENCES} onClick={() => file.current?.click()}>
        <Icon name="plus" size={13} /> Añadir referencia
      </button>
      <input ref={file} type="file" aria-label="Archivo de referencia" hidden accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (chosen) void update(async () => design.addReference(project, screen, chosen.name, await referenceData(chosen)), 'Referencia guardada.');
        }} />
    </div>
    {items && (items.length ? <>
      <div className="studio-reference-grid">{items.map((item) => <div className="studio-reference" key={item.id}>
        <button className="studio-reference-thumb" aria-label={`Ver referencia ${item.name}`} onClick={() => setPreview(item)}>
          <img src={imageUrl(item)} alt="" /><span title={item.name}>{item.name}</span>
        </button>
        <label><input type="checkbox" aria-label={`Adjuntar ${item.name}`} checked={included.includes(item.id)}
          disabled={busy || (!included.includes(item.id) && included.length >= MAX_INCLUDED)}
          onChange={(event) => onIncluded(event.currentTarget.checked ? [...included, item.id] : included.filter((id) => id !== item.id))} /> Adjuntar</label>
      </div>)}</div>
      <p className="mut2">{included.length} de {MAX_INCLUDED} disponibles para el siguiente encargo.</p>
    </> : <p className="mut2">Añade imágenes para orientar los cambios en esta pantalla.</p>)}
    {status && <p className="mut2" role="status">{status}</p>}
    {preview && <Modal title={preview.name} onClose={() => setPreview(null)}>
      <img className="studio-reference-preview" src={imageUrl(preview)} alt={preview.name} />
      <div className="acts">
        <button className="tr-btn ghost" disabled={busy} onClick={async () => {
          const removed = await update(async () => {
            await design.removeReference(project, screen, preview.id);
            onIncluded(included.filter((id) => id !== preview.id));
          }, 'Referencia eliminada.');
          if (removed) setPreview(null);
        }}>Quitar referencia</button>
        <button className="tr-btn pearl" onClick={() => setPreview(null)}>Cerrar</button>
      </div>
    </Modal>}
  </section>;
}
