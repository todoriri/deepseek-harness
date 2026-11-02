/** Browser-local microphone preference shared by settings previews and dictation. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** An empty id follows the system input; labels store browser names without localized placeholders. */
export interface MicrophoneDevice {
  readonly id: string
  readonly label: string
}

/** Admit a stored selection only when both fields are strings. */
function parseMicrophoneDevice(value: unknown): MicrophoneDevice | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('label' in value)) return undefined
  const { id, label } = value
  return typeof id === 'string' && typeof label === 'string' ? { id, label } : undefined
}

/**
 * Restore the browser preference independently of Host recognition settings.
 * @returns validated device selection, persisted through the shared Client store.
 */
export function createMicrophoneDeviceStore(): SnapshotStore<MicrophoneDevice> {
  return createSnapshotStore<MicrophoneDevice>({ id: '', label: '' }, {
    persist: { name: 'dsh.voice-input.microphone', parse: parseMicrophoneDevice },
  })
}
