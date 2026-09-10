import { useEffect, useRef } from 'react';

interface SignaturePadProps {
  value: string;
  onChange: (dataUrl: string) => void;
  disabled?: boolean;
  transparent?: boolean;
  showClear?: boolean;
  className?: string;
  /** Thicker stroke for finger signing. */
  finger?: boolean;
}

function strokeWidth(finger: boolean, pointerType?: string) {
  if (finger || pointerType === 'touch' || pointerType === 'pen') return 3.6;
  return 2.4;
}

function paintCanvas(
  canvas: HTMLCanvasElement,
  value: string,
  transparent: boolean,
  finger: boolean
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nextWidth = Math.max(1, Math.floor(width * ratio));
  const nextHeight = Math.max(1, Math.floor(height * ratio));
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (transparent) {
    context.clearRect(0, 0, width, height);
  } else {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.strokeStyle = '#1a1a1a';
  context.lineWidth = strokeWidth(finger);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (!value) return;
  const image = new Image();
  image.onload = () => {
    context.drawImage(image, 0, 0, width, height);
  };
  image.src = value;
}

export default function SignaturePad({
  value,
  onChange,
  disabled,
  transparent = false,
  showClear = true,
  className,
  finger = false,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const lastExported = useRef(value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => {
      if (drawing.current) return;
      paintCanvas(canvas, lastExported.current, transparent, finger);
    };
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [transparent, finger]);

  useEffect(() => {
    if (value === lastExported.current && value) return;
    lastExported.current = value;
    const canvas = canvasRef.current;
    if (canvas) paintCanvas(canvas, value, transparent, finger);
  }, [value, transparent, finger]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    last.current = point(event);
    const context = event.currentTarget.getContext('2d');
    if (context) context.lineWidth = strokeWidth(finger, event.pointerType);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const from = last.current;
    if (!canvas || !context || !from) return;
    const to = point(event);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    last.current = to;
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    lastExported.current = dataUrl;
    onChange(dataUrl);
  };

  const clear = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    drawing.current = false;
    last.current = null;
    lastExported.current = '';
    const canvas = canvasRef.current;
    if (canvas) paintCanvas(canvas, '', transparent, finger);
    onChange('');
  };

  return (
    <div className={className ? `signature-pad ${className}` : 'signature-pad'}>
      <canvas
        ref={canvasRef}
        className="signature-pad__canvas"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        style={{ touchAction: 'none' }}
      />
      {showClear && !disabled && (
        <button type="button" className="signature-pad__clear" onClick={clear}>
          Clear signature
        </button>
      )}
    </div>
  );
}
