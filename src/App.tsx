// =============================================================================
// DICOM Annotation Viewer — Main Application
// Atomorphic Mini Hackathon
// =============================================================================
//
// This viewer is ALREADY WORKING (load DICOM, scroll, W/L, draw annotations).
// Your four hackathon tasks are to ADD NEW FEATURES using the skeleton
// functions below — look for the TODO markers!
//
// Tasks summary:
//   Task 1 — Study Selector          → handleSelectStudy()
//   Task 2 — Load Ground Truth        → handleLoadGT()
//   Task 3 — Run AI Segmentation      → handleRunAI()
//   Task 4 — Show AI Segmentation     → handleShowAISeg()
//   Bonus A — AI-Assisted Segmentation → handleAIAssist()
//   Bonus B — UI Polish / Extra Tools
//
// See HACKATHON_TASKS.md for full specifications and hints.
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  initCornerstone,
  initViewport,
  initTools,
  setActiveTool,
  getRenderingEngine,
  setupResizeObserver,
  VIEWPORT_ID,
} from './core/init'
import { loadDicomFiles, loadStudy, getImageIds, LIDC_STUDIES } from './core/loader'
import {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  LengthTool,
  RectangleROITool,
  PlanarFreehandROITool,
  annotation,
  segmentation,
} from '@cornerstonejs/tools'
import { Enums as CoreEnums, metaData, utilities } from '@cornerstonejs/core'
import { Enums as ToolEnums } from '@cornerstonejs/tools'
import * as dicomParser from 'dicom-parser'

// ─── Types ────────────────────────────────────────────────────────────────────
type NavTool  = 'WindowLevel' | 'Pan' | 'Zoom'
type DrawTool = 'Length' | 'RectangleROI' | 'Freehand'
type ActiveTool = NavTool | DrawTool

interface SegmentEntry { index: number; label: string; color: number[] }
interface AnnotationEntry { uid: string; type: string }
interface Info { slice: string; total: string; wl: string }

// =============================================================================
export default function App() {
  const viewportRef  = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [ready,       setReady]       = useState(false)
  const [status,      setStatus]      = useState('Initialising...')
  const [activeTool,  setActiveToolUI] = useState<ActiveTool>('WindowLevel')
  const [activeStudy, setActiveStudy] = useState<string | null>(null)
  const [info,        setInfo]        = useState<Info>({ slice: '--', total: '--', wl: '--' })
  const [segments,    setSegments]    = useState<SegmentEntry[]>([])
  const [annotations, setAnnotations] = useState<AnnotationEntry[]>([])
  const [aiSegPath,   setAiSegPath]   = useState<string | null>(null)

  // ── Initialise Cornerstone once the viewport div is mounted ────────────────
  useEffect(() => {
    if (!viewportRef.current) return
    const el = viewportRef.current

    let cleanupResize: (() => void) | undefined

    ;(async () => {
      try {
        setStatus('Initialising Cornerstone3D…')
        await initCornerstone()
        initViewport(el)
        initTools()
        cleanupResize = setupResizeObserver(el)
        setReady(true)
        setStatus('Ready — select a study from the panel to begin')
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    return () => { cleanupResize?.() }
  }, [])

  // ── Slice change listener ──────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !viewportRef.current) return
    const el = viewportRef.current

    const handleSlice = () => {
      const re = getRenderingEngine()
      if (!re) return
      const vp = re.getViewport(VIEWPORT_ID) as any
      const idx = vp?.getCurrentImageIdIndex?.() ?? 0
      setInfo(prev => ({ ...prev, slice: String(idx + 1), total: String(getImageIds().length) }))
    }

    el.addEventListener(CoreEnums.Events.STACK_VIEWPORT_SCROLL, handleSlice)
    return () => el.removeEventListener(CoreEnums.Events.STACK_VIEWPORT_SCROLL, handleSlice)
  }, [ready])

  // ── W/L change listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !viewportRef.current) return
    const el = viewportRef.current

    const handleVOI = (evt: Event) => {
      const { range } = (evt as CustomEvent).detail ?? {}
      if (!range) return
      const W = Math.round(range.upper - range.lower)
      const L = Math.round((range.upper + range.lower) / 2)
      setInfo(prev => ({ ...prev, wl: `${W} / ${L}` }))
    }

    el.addEventListener(CoreEnums.Events.VOI_MODIFIED, handleVOI)
    return () => el.removeEventListener(CoreEnums.Events.VOI_MODIFIED, handleVOI)
  }, [ready])

  // ── Annotation change listener ─────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !viewportRef.current) return
    const el = viewportRef.current

    const refresh = () => {
      const all = annotation.state.getAllAnnotations()
      setAnnotations(all.map(a => ({ uid: a.annotationUID ?? '', type: a.metadata?.toolName ?? '' })))
    }

    el.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, refresh)
    el.addEventListener(ToolEnums.Events.ANNOTATION_REMOVED,   refresh)
    return () => {
      el.removeEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, refresh)
      el.removeEventListener(ToolEnums.Events.ANNOTATION_REMOVED,   refresh)
    }
  }, [ready])

  // ── File loading ───────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setStatus(`Loading ${files.length} file(s)…`)
    const n = await loadDicomFiles(Array.from(files), (loaded, total) =>
      setStatus(`Loading… ${loaded}/${total}`)
    )
    if (n === 0) { setStatus('No DICOM files found'); return }
    setInfo(prev => ({ ...prev, slice: String(Math.floor(n / 2) + 1), total: String(n) }))
    setStatus(`Loaded ${n} image${n !== 1 ? 's' : ''}`)
  }, [])

  // ── Navigation tool switch ─────────────────────────────────────────────────
  const handleNavTool = useCallback((tool: NavTool) => {
    const name = tool === 'WindowLevel' ? WindowLevelTool.toolName
               : tool === 'Pan'         ? PanTool.toolName
                                        : ZoomTool.toolName
    setActiveTool(name)
    setActiveToolUI(tool)
  }, [])

  // ── Annotation tool switch ─────────────────────────────────────────────────
  const handleDrawTool = useCallback((tool: DrawTool) => {
    const name = tool === 'Length'       ? LengthTool.toolName
               : tool === 'RectangleROI' ? RectangleROITool.toolName
                                         : PlanarFreehandROITool.toolName
    setActiveTool(name)
    setActiveToolUI(tool)
  }, [])

  // ── Reset view ─────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    const re = getRenderingEngine()
    if (!re) return
    const vp = re.getViewport(VIEWPORT_ID) as any
    vp?.resetCamera?.()
    vp?.render?.()
    setStatus('View reset')
  }, [])

  // ── Export JSON (built-in utility) ─────────────────────────────────────────
  const handleExportJSON = useCallback(() => {
    const all = annotation.state.getAllAnnotations()
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'annotations.json'; a.click()
    URL.revokeObjectURL(url)
    setStatus('Exported annotations.json')
  }, [])

  // ===========================================================================
  // HACKATHON TASKS — implement the functions below
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // TASK 1 — Study Selector
  // ---------------------------------------------------------------------------
  // Build a data panel that lists the available LIDC studies and loads the
  // selected study's CT slices into the viewer.
  //
  // LIDC_STUDIES (imported from ./core/loader) is an array of study metadata.
  // loadStudy(caseId) (also in ./core/loader) fetches and loads the CT slices.
  //
  // See HACKATHON_TASKS.md § Task 1 for hints.
  //
  const handleSelectStudy = useCallback(async (caseId: string) => {
    if (!ready) return
    if (activeStudy === caseId) return

    try {
      setStatus(`Loading ${caseId}...`)
      const n = await loadStudy(caseId, (loaded, total) => {
        setStatus(`Loading ${caseId}… ${loaded}/${total}`)
      })
      setActiveStudy(caseId)
      setAiSegPath(null)
      setSegments([])
      setInfo(prev => ({ ...prev, slice: String(Math.floor(n / 2) + 1), total: String(n) }))
      setStatus(`Loaded ${caseId} (${n} slices)`)
    } catch (err) {
      console.error('Failed to load study:', err)
      setStatus(`Failed to load ${caseId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeStudy, ready])

  // ---------------------------------------------------------------------------
  // TASK 2 — Load Ground Truth Annotations
  // ---------------------------------------------------------------------------
  // Load the LIDC XML file for the active study and render the
  // radiologist-drawn nodule contours as PlanarFreehandROI annotations
  // on the correct slices.
  //
  // See HACKATHON_TASKS.md § Task 2 for hints.
  //
  const handleLoadGT = useCallback(async () => {
    if (!ready) return
    if (!activeStudy) {
      setStatus('Select a study first')
      return
    }

    const study = LIDC_STUDIES.find(s => s.id === activeStudy)
    if (!study) {
      setStatus(`Unknown study: ${activeStudy}`)
      return
    }

    const imageIds = getImageIds()
    if (imageIds.length === 0) {
      setStatus('No CT stack loaded')
      return
    }

    const groupSelector = viewportRef.current
    if (!groupSelector) {
      setStatus('Viewport not ready')
      return
    }

    try {
      setStatus(`Loading GT XML for ${activeStudy}...`)
      const xmlPath = `/data/${activeStudy}/annotations/${study.xml}`
      const response = await fetch(xmlPath)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const xmlText = await response.text()
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
      const ns = doc.documentElement.namespaceURI || 'http://www.nih.gov'

      const roiElements = Array.from(doc.getElementsByTagNameNS(ns, 'roi'))
      if (roiElements.length === 0) {
        setStatus('No ROI contours found in XML')
        return
      }

      const slices = imageIds
        .map(imageId => {
          const plane = metaData.get('imagePlaneModule', imageId) as
            | { imagePositionPatient?: [number, number, number] }
            | undefined
          const z = Number(plane?.imagePositionPatient?.[2])
          return Number.isFinite(z) ? { imageId, z } : null
        })
        .filter((s): s is { imageId: string; z: number } => s !== null)
        .sort((a, b) => a.z - b.z)

      if (slices.length === 0) {
        throw new Error('Slice z-positions are unavailable')
      }

      const getNearestImageId = (z: number) => {
        let lo = 0
        let hi = slices.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (slices[mid].z < z) lo = mid + 1
          else hi = mid
        }
        if (lo === 0) return slices[0].imageId
        const prev = slices[lo - 1]
        const curr = slices[lo]
        return Math.abs(prev.z - z) <= Math.abs(curr.z - z) ? prev.imageId : curr.imageId
      }

      const readText = (el: Element, tagName: string): string | null => {
        const nsMatch = el.getElementsByTagNameNS(ns, tagName)[0]
        if (nsMatch?.textContent) return nsMatch.textContent
        const anyNsMatch = el.getElementsByTagNameNS('*', tagName)[0]
        if (anyNsMatch?.textContent) return anyNsMatch.textContent
        return null
      }

      let loaded = 0
      let skipped = 0

      for (const roi of roiElements) {
        const zText = readText(roi, 'imageZposition')
        const z = Number(zText)
        if (!Number.isFinite(z)) {
          skipped += 1
          continue
        }

        const edgeMaps = Array.from(roi.getElementsByTagNameNS(ns, 'edgeMap'))
        if (edgeMaps.length < 3) {
          skipped += 1
          continue
        }

        const referencedImageId = getNearestImageId(z)
        const contour: [number, number, number][] = []

        for (const edge of edgeMaps) {
          const x = Number(readText(edge, 'xCoord'))
          const y = Number(readText(edge, 'yCoord'))
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue

          const world = utilities.imageToWorldCoords(referencedImageId, [y, x]) as [number, number, number]
          contour.push([world[0], world[1], z])
        }

        if (contour.length < 3) {
          skipped += 1
          continue
        }

        const plane = metaData.get('imagePlaneModule', referencedImageId) as
          | { frameOfReferenceUID?: string }
          | undefined

        annotation.state.addAnnotation(
          {
            highlighted: false,
            invalidated: true,
            metadata: {
              toolName: PlanarFreehandROITool.toolName,
              referencedImageId,
              FrameOfReferenceUID: plane?.frameOfReferenceUID,
            },
            data: {
              label: `GT contour ${loaded + 1}`,
              contour: {
                closed: true,
                polyline: contour,
              },
              handles: {
                points: contour,
              },
              cachedStats: {},
            },
          },
          groupSelector
        )

        loaded += 1
      }

      const re = getRenderingEngine()
      const vp = re?.getViewport(VIEWPORT_ID) as any
      vp?.render?.()

      const all = annotation.state.getAllAnnotations()
      setAnnotations(all.map(a => ({ uid: a.annotationUID ?? '', type: a.metadata?.toolName ?? '' })))
      setStatus(`Loaded ${loaded} GT contour${loaded === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}`)
    } catch (err) {
      console.error('Failed to load GT annotations:', err)
      setStatus(`Failed to load GT: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeStudy, ready])

   // ---------------------------------------------------------------------------
  // TASK 3 — Run AI Segmentation Model
  // ---------------------------------------------------------------------------
  // Trigger TotalSegmentator or MONAI Label on the active study's CT data and
  // retrieve the segmentation result so Task 4 can display it.
  //
  // See HACKATHON_TASKS.md § Task 3 for hints and available scripts.
  //
  const handleRunAI = useCallback(async () => {
    if (!activeStudy) {
      setStatus('No study selected')
      return
    }
  
    try {
      setStatus(`Running AI segmentation for ${activeStudy}...`)
    
      const res = await fetch(`http://localhost:8000/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: activeStudy })
      })
    
      if (!res.ok) throw new Error('AI failed')
      
      const result = await res.json()
      setAiSegPath(typeof result.seg_path === 'string' ? result.seg_path : null)
      setStatus(`AI completed: ${result.seg_path}`)
    } catch (err) {
      console.error(err)
      setStatus('AI segmentation failed')
    }
  }, [activeStudy])

  // ---------------------------------------------------------------------------
  // TASK 4 — Display AI Segmentation Overlay
  // ---------------------------------------------------------------------------
  // Load a DICOM SEG file (from Task 3, or the pre-computed fallback in
  // data/<activeStudy>/annotations/) and display it as a coloured labelmap
  // overlay using Cornerstone3D's segmentation API.
  //
  // See HACKATHON_TASKS.md § Task 4 for hints.
  //
  const handleShowAISeg = useCallback(async () => {
    if (!ready) return
    
    if (!activeStudy) {
      setStatus('Select a study first')
      return
    }
  
    try {
      setStatus(`Loading AI segmentation for ${activeStudy}...`)

      const fallbackSegPath = `data/${activeStudy}/annotations/${activeStudy}_lung_nodules_seg.dcm`
      const segPath = (aiSegPath ?? fallbackSegPath).replace(/^\/+/, '')
      const segUrl = `/${segPath}`

      const segResponse = await fetch(segUrl)
      if (!segResponse.ok) throw new Error(`SEG fetch failed: HTTP ${segResponse.status}`)

      const segBytes = new Uint8Array(await segResponse.arrayBuffer())
      const segDataSet = dicomParser.parseDicom(segBytes)
      const numberOfFrames = Number(segDataSet.string('x00280008') ?? '1')
      if (!Number.isFinite(numberOfFrames) || numberOfFrames <= 0) {
        throw new Error('SEG NumberOfFrames is invalid')
      }

      const ctImageIds = getImageIds()
      if (ctImageIds.length === 0) {
        throw new Error('No CT stack loaded')
      }

      if (numberOfFrames !== ctImageIds.length) {
        throw new Error(`SEG frames (${numberOfFrames}) do not match CT slices (${ctImageIds.length})`)
      }

      const segImageIds = Array.from(
        { length: numberOfFrames },
        (_, i) => `wadouri:${segUrl}?frame=${i + 1}`
      )

      const segmentationId = `seg-${activeStudy}`

      try {
        segmentation.removeSegmentationRepresentations(VIEWPORT_ID, { segmentationId })
      } catch {
        // no existing representation to remove
      }
      try {
        segmentation.state.removeSegmentation(segmentationId)
      } catch {
        // no existing segmentation state to remove
      }

      segmentation.state.addSegmentations([
        {
          segmentationId,
          representation: {
            type: ToolEnums.SegmentationRepresentations.Labelmap,
            data: {
              imageIds: segImageIds,
            },
          },
        },
      ])

      segmentation.addLabelmapRepresentationToViewportMap({
        [VIEWPORT_ID]: [{ segmentationId }],
      })

      const segmentSeq = segDataSet.elements.x00620002
      const palette = [
        [230, 57, 70],
        [69, 123, 157],
        [42, 157, 143],
        [233, 196, 106],
        [244, 162, 97],
        [168, 218, 220],
      ]
      const loadedSegments: SegmentEntry[] = []
      if (segmentSeq?.items?.length) {
        segmentSeq.items.forEach((item: any, idx: number) => {
          const ds = item?.dataSet
          const segmentNumber = Number(ds?.uint16?.('x00620004') ?? idx + 1)
          const segmentLabel = ds?.string?.('x00620005')?.trim() || `Segment ${segmentNumber}`
          loadedSegments.push({
            index: segmentNumber,
            label: segmentLabel,
            color: palette[idx % palette.length],
          })
        })
      } else {
        loadedSegments.push({
          index: 1,
          label: 'AI Segmentation',
          color: [230, 57, 70],
        })
      }
      setSegments(loadedSegments)

      const re = getRenderingEngine()
      const viewport = re?.getViewport(VIEWPORT_ID)

      if (!viewport) throw new Error('Viewport not available')

      viewport.render()

      setStatus(`AI segmentation displayed for ${activeStudy}`)
    } catch (err) {
      console.error('Failed to load AI segmentation:', err)
      setStatus(`Failed to show AI segmentation: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeStudy, aiSegPath, ready])

  // ---------------------------------------------------------------------------
  // BONUS A — AI-Assisted Segmentation
  // ---------------------------------------------------------------------------
  // POST the active study ID to a local segmentation API at localhost:8000,
  // receive the resulting DICOM SEG path, and display it as a labelmap overlay.
  // Show loading feedback while the model runs and handle errors gracefully.
  //
  // API: POST http://localhost:8000/segment  { case_id: string }
  //      → { seg_path: string }
  //
  // See HACKATHON_TASKS.md § Bonus A for hints.
  //
  const handleAIAssist = useCallback(async () => {
    // TODO Bonus A — implement handleAIAssist()
    console.warn('Bonus A not yet implemented')
    setStatus('Bonus A: AI-Assisted Segmentation — not yet implemented')
  }, [activeStudy])

  // ==========================================================================
  return (
    <div id="app">

      {/* Header */}
      <header className="header">
        <h1>DICOM Annotation Viewer</h1>
        <span className="subtitle">Atomorphic Mini Hackathon</span>
      </header>

      {/* Toolbar */}
      <div className="toolbar">

        {/* File loading */}
        <div className="tool-group">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".dcm"
            style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)}
          />
          <button disabled={!ready} onClick={() => fileInputRef.current?.click()}>
            Load DICOM
          </button>
        </div>

        <div className="divider" />

        {/* Navigation tools */}
        <div className="tool-group">
          {(['WindowLevel', 'Pan', 'Zoom'] as NavTool[]).map(tool => (
            <button
              key={tool}
              disabled={!ready}
              className={activeTool === tool ? 'active' : ''}
              onClick={() => handleNavTool(tool)}
            >
              {tool === 'WindowLevel' ? 'W/L' : tool}
            </button>
          ))}
        </div>

        <div className="divider" />

        {/* Annotation drawing tools */}
        <div className="tool-group">
          {([
            ['Length',       'Length'],
            ['RectangleROI', 'Rect'],
            ['Freehand',     'Freehand'],
          ] as [DrawTool, string][]).map(([tool, label]) => (
            <button
              key={tool}
              disabled={!ready}
              className={activeTool === tool ? 'active' : ''}
              onClick={() => handleDrawTool(tool)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="divider" />

        {/* Utility */}
        <div className="tool-group">
          <button disabled={!ready} onClick={handleReset}>Reset</button>
          <button disabled={!ready} onClick={handleExportJSON}>Export JSON</button>
        </div>

        <div className="divider" />

        {/* ── HACKATHON TASK BUTTONS ── */}
        <div className="tool-group hackathon-tasks">
          <button disabled={!ready} onClick={handleLoadGT}>
            Load GT
          </button>
          <button disabled={!ready} onClick={handleRunAI}>
            Run AI
          </button>
          <button disabled={!ready} onClick={handleShowAISeg}>
            Show AI Seg
          </button>
          <button disabled={!ready} onClick={handleAIAssist}>
            AI Assist
          </button>
        </div>

      </div>

      {/* Main content */}
      <div className="main-content">

        {/* Left panel — image info + study selector */}
        <div className="panel">
          <h3>Image Info</h3>
          <div className="list-content">
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  ['Slice',  `${info.slice} / ${info.total}`],
                  ['W / L',  info.wl],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-dim)', paddingBottom: 6 }}>{label}</td>
                    <td style={{ paddingBottom: 6 }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── TASK 1: Study Selector — implement handleSelectStudy() ── */}
          <h3 style={{ borderTop: '1px solid var(--border)' }}>Studies</h3>
          <div className="list-content">
            {LIDC_STUDIES.map(study => (
              <button
                key={study.id}
                type="button"
                disabled={!ready}
                className={`study-item ${activeStudy === study.id ? 'selected' : ''}`}
                onClick={() => handleSelectStudy(study.id)}
                title={`Load ${study.id}`}
              >
                <span className="study-id">{study.id}</span>
                <span className="study-meta">{study.slices} slices • {study.xml}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Viewport */}
        <div className="viewport-container">
          <div className="viewport">
            <div ref={viewportRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>

        {/* Right panel — annotations + segments */}
        <div className="panel right-panel">
          <h3>Annotations</h3>
          <div className="list-content">
            {annotations.length === 0
              ? <p className="empty">No annotations</p>
              : annotations.map(a => (
                  <div key={a.uid} className="annotation-item">
                    <span className="annotation-type">{a.type}</span>
                  </div>
                ))
            }
          </div>

          <h3 style={{ borderTop: '1px solid var(--border)' }}>Segments</h3>
          <div className="list-content">
            {segments.length === 0
              ? <p className="empty">No segmentation loaded</p>
              : segments.map(s => (
                  <div key={s.index} className="segment-item">
                    <span
                      className="segment-color"
                      style={{ background: `rgb(${s.color[0]},${s.color[1]},${s.color[2]})` }}
                    />
                    <span className="segment-label">{s.label}</span>
                  </div>
                ))
            }
          </div>
        </div>

      </div>

      {/* Status bar */}
      <footer className="status-bar">{status}</footer>

    </div>
  )
}
