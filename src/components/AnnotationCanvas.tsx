import { useEffect, useRef, useState } from 'react'
import { Pen, ArrowRight, Square, Undo2, Trash2 } from 'lucide-react'

/**
 * Image annotation canvas — pen + arrow + rectangle on top of a
 * screenshot, baked into a single JPEG dataURL when the user submits.
 *
 * Used on the review page so clients can circle a face, point an
 * arrow at a misspelled subtitle, or draw a square around the
 * graphic they want moved — without typing twenty words to describe
 * which on-screen element they mean.
 *
 * Coordinate model:
 *   The canvas sits at the image's NATURAL pixel dimensions (capped
 *   at 1280 wide upstream by captureFrame). CSS scales it to fit
 *   the modal. Pointer events translate from CSS pixels back to
 *   canvas pixels via the bounding-rect ratio, so a stroke drawn
 *   on a phone (canvas displayed at 320px wide) ends up in the
 *   same place when viewed on the editor's 27" monitor (canvas
 *   displayed at 1280px wide). On submit we toDataURL() once —
 *   no re-baking, no quality loss from repeat round-trips.
 *
 * Why not <Stage> from konva.js?
 *   We need exactly three tools and no library polish — adding a
 *   ~50KB+ canvas framework to the public review page would slow
 *   first-paint for a feature most viewers never even touch.
 */

export type AnnotationColor = 'red' | 'yellow' | 'green' | 'cyan'
export type AnnotationTool = 'pen' | 'arrow' | 'rect'

interface Stroke {
  tool: AnnotationTool
  color: string
  thickness: number
  // For pen: many points. For arrow/rect: exactly 2 (start, end).
  points: { x: number; y: number }[]
}

const COLOR_HEX: Record<AnnotationColor, string> = {
  red: '#ef4444',
  yellow: '#facc15',
  green: '#22c55e',
  cyan: '#22d3ee',
}

const COLOR_LABEL: Record<AnnotationColor, string> = {
  red: 'אדום',
  yellow: 'צהוב',
  green: 'ירוק',
  cyan: 'תכלת',
}

/**
 * Props:
 *   imageUrl      — the original screenshot JPEG dataURL
 *   onChange      — fires on every stroke commit with the BAKED
 *                   annotated dataURL (or null if no strokes yet,
 *                   meaning "use the original"). Parent can submit
 *                   this directly without asking the canvas again.
 */
export function AnnotationCanvas({
  imageUrl,
  onChange,
}: {
  imageUrl: string
  onChange: (annotatedDataUrl: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageReady, setImageReady] = useState(false)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [tool, setTool] = useState<AnnotationTool>('pen')
  const [color, setColor] = useState<AnnotationColor>('red')
  // The stroke currently being drawn (between pointerdown + up).
  // Stored separately from `strokes` so we can preview without
  // mutating the committed history (cleaner undo semantics).
  const [draft, setDraft] = useState<Stroke | null>(null)

  // Load the image once + size the canvas to its natural pixels.
  // Doing this in an effect (not directly in render) avoids a
  // flash of an empty canvas before the image decodes.
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      imageRef.current = img
      setImageReady(true)
    }
    img.src = imageUrl
  }, [imageUrl])

  // Redraw on every change. The whole thing is wiped + repainted
  // because partial redraw + erase-by-clearing-region gets messy
  // with the draft stroke on top.
  useEffect(() => {
    if (!imageReady) return
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    for (const s of strokes) paintStroke(ctx, s)
    if (draft) paintStroke(ctx, draft)
  }, [strokes, draft, imageReady])

  // Notify parent of committed annotation result. We do this when
  // `strokes` changes (not on every draft update during a drag —
  // that would re-encode the entire image dozens of times per
  // second and crush low-end phones).
  useEffect(() => {
    if (!imageReady) return
    if (strokes.length === 0) {
      onChange(null)
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    // JPEG 0.85 — slightly higher than the capture default because
    // re-encoding through canvas loses a bit of fidelity and we
    // want strokes to stay crisp.
    onChange(canvas.toDataURL('image/jpeg', 0.85))
  }, [strokes, imageReady, onChange])

  function getThickness(): number {
    const canvas = canvasRef.current
    if (!canvas) return 4
    // ~0.4% of the longest edge. 5px on 1280px wide → visible without
    // being cartoonish; scales naturally for portrait videos too.
    return Math.max(3, Math.round(Math.max(canvas.width, canvas.height) * 0.004))
  }

  function pointFromEvent(e: React.PointerEvent): { x: number; y: number } {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    }
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!imageReady) return
    e.preventDefault()
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
    setDraft({
      tool,
      color: COLOR_HEX[color],
      thickness: getThickness(),
      points: [pointFromEvent(e)],
    })
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!draft) return
    const point = pointFromEvent(e)
    setDraft((cur) => {
      if (!cur) return cur
      if (cur.tool === 'pen') {
        return { ...cur, points: [...cur.points, point] }
      }
      // arrow / rect — only the first + current points matter
      return { ...cur, points: [cur.points[0], point] }
    })
  }

  function handlePointerUp() {
    if (!draft) return
    // Discard zero-length strokes (a stray tap that didn't drag).
    // For pen we keep tiny strokes (dot annotations); for shape
    // tools we require some movement so we don't end up with an
    // invisible 1px rectangle in the saved image.
    const valid =
      draft.tool === 'pen' ||
      (draft.points.length === 2 &&
        Math.hypot(
          draft.points[1].x - draft.points[0].x,
          draft.points[1].y - draft.points[0].y,
        ) > 4)
    if (valid) {
      setStrokes((prev) => [...prev, draft])
    }
    setDraft(null)
  }

  function undo() {
    setStrokes((prev) => prev.slice(0, -1))
  }
  function clear() {
    setStrokes([])
  }

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-white/5 bg-white/[0.02] p-1.5">
        <ToolButton
          label="עט חופשי"
          active={tool === 'pen'}
          onClick={() => setTool('pen')}
        >
          <Pen className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton
          label="חץ"
          active={tool === 'arrow'}
          onClick={() => setTool('arrow')}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton
          label="ריבוע"
          active={tool === 'rect'}
          onClick={() => setTool('rect')}
        >
          <Square className="h-3.5 w-3.5" />
        </ToolButton>

        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />

        {/* Color picker — each swatch is its own button. Ring on
            the active one is more accessible than just a border
            color change (visible on color-blind screens). */}
        {(Object.keys(COLOR_HEX) as AnnotationColor[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            aria-label={`צבע ${COLOR_LABEL[c]}`}
            title={COLOR_LABEL[c]}
            className={`h-7 w-7 rounded-md transition-all ${
              color === c
                ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-bg scale-105'
                : 'ring-1 ring-white/20 hover:ring-white/40'
            }`}
            style={{ backgroundColor: COLOR_HEX[c] }}
          />
        ))}

        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />

        <ToolButton
          label="ביטול אחרון"
          onClick={undo}
          disabled={strokes.length === 0}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton
          label="ניקוי הכל"
          onClick={clear}
          disabled={strokes.length === 0}
          danger
        >
          <Trash2 className="h-3.5 w-3.5" />
        </ToolButton>

        {strokes.length > 0 && (
          <span className="mr-auto text-[10px] text-fg-muted">
            {strokes.length} סימונים
          </span>
        )}
      </div>

      {/* Canvas — bordered + centered on black so the image always
          reads as "the thing being annotated". touch-action: none
          prevents the browser from interpreting the drag as a scroll
          gesture on mobile. */}
      <div className="flex items-center justify-center rounded-lg border border-white/10 bg-black/40 p-1">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="block max-h-[42vh] w-auto max-w-full cursor-crosshair touch-none"
          style={{ touchAction: 'none' }}
        />
      </div>
    </div>
  )
}

function ToolButton({
  label,
  active,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ' +
        (active
          ? 'bg-primary/20 text-primary '
          : danger
            ? 'text-fg-muted hover:bg-destructive/15 hover:text-destructive '
            : 'text-fg-muted hover:bg-white/5 hover:text-fg ') +
        (disabled ? 'cursor-not-allowed opacity-30 hover:bg-transparent hover:text-fg-muted ' : '')
      }
    >
      {children}
    </button>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Canvas painters — pure functions, no React state. Take the
 *  2D context + stroke and put pixels on screen.
 * ───────────────────────────────────────────────────────────── */

function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.thickness
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (s.tool === 'pen') {
    if (s.points.length < 1) return
    if (s.points.length === 1) {
      // Single-tap dot — draw a filled circle so it shows up.
      const p = s.points[0]
      ctx.beginPath()
      ctx.arc(p.x, p.y, s.thickness / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(s.points[0].x, s.points[0].y)
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y)
    }
    ctx.stroke()
    return
  }

  if (s.points.length < 2) return
  const [a, b] = s.points

  if (s.tool === 'arrow') {
    // Shaft
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    // Arrowhead — filled triangle at the tip. headLen scaled to
    // line thickness so big strokes get big arrows.
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const headLen = s.thickness * 5
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(
      b.x - headLen * Math.cos(angle - Math.PI / 6),
      b.y - headLen * Math.sin(angle - Math.PI / 6),
    )
    ctx.lineTo(
      b.x - headLen * Math.cos(angle + Math.PI / 6),
      b.y - headLen * Math.sin(angle + Math.PI / 6),
    )
    ctx.closePath()
    ctx.fill()
    return
  }

  if (s.tool === 'rect') {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    ctx.strokeRect(x, y, w, h)
    return
  }
}
