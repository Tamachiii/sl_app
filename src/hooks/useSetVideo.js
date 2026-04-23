import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

const BUCKET = 'set-videos';
const MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

function extFromMime(mime) {
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/quicktime') return 'mov';
  return 'bin';
}

export function useSetVideos(sessionId, slotIds) {
  const sortedIds = [...(slotIds || [])].sort();
  return useQuery({
    queryKey: ['set-videos', sessionId, sortedIds],
    queryFn: async () => {
      if (sortedIds.length === 0) return [];
      const { data: logs, error: logErr } = await supabase
        .from('set_logs')
        .select('id, exercise_slot_id, set_number')
        .in('exercise_slot_id', sortedIds);
      if (logErr) throw logErr;
      const logIds = (logs || []).map((l) => l.id);
      if (logIds.length === 0) return [];
      const { data: videos, error: vidErr } = await supabase
        .from('set_log_videos')
        .select('*')
        .in('set_log_id', logIds);
      if (vidErr) throw vidErr;
      const byLogId = new Map((logs || []).map((l) => [l.id, l]));
      return (videos || []).map((v) => {
        const log = byLogId.get(v.set_log_id);
        return {
          ...v,
          exercise_slot_id: log?.exercise_slot_id,
          set_number: log?.set_number,
        };
      });
    },
    enabled: !!sessionId && sortedIds.length > 0,
  });
}

export function useUploadSetVideo() {
  const qc = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ setLogId, exerciseSlotId, setNumber, file }) => {
      if (!user?.id) throw new Error('Not signed in');
      if (!file) throw new Error('No file selected');
      if (file.size > MAX_BYTES) {
        throw new Error(
          `Clip is ${(file.size / 1024 / 1024).toFixed(1)} MB — please keep it under 25 MB. Record a shorter clip or lower quality.`
        );
      }

      const { data: existing, error: existErr } = await supabase
        .from('set_log_videos')
        .select('id, storage_path')
        .eq('set_log_id', setLogId)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        await supabase.storage.from(BUCKET).remove([existing.storage_path]);
        const { error: delErr } = await supabase
          .from('set_log_videos')
          .delete()
          .eq('id', existing.id);
        if (delErr) throw delErr;
      }

      const ext = extFromMime(file.type);
      const uid =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const storagePath = `${user.id}/${exerciseSlotId}/${setNumber}-${uid}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, {
          contentType: file.type,
          upsert: false,
        });
      if (upErr) throw upErr;

      const { data, error: rowErr } = await supabase
        .from('set_log_videos')
        .insert({
          set_log_id: setLogId,
          storage_path: storagePath,
          mime_type: file.type,
          size_bytes: file.size,
        })
        .select()
        .single();
      if (rowErr) {
        await supabase.storage.from(BUCKET).remove([storagePath]);
        throw rowErr;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['set-videos'] });
    },
  });
}

export function useDeleteSetVideo() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ videoId, storagePath }) => {
      await supabase.storage.from(BUCKET).remove([storagePath]);
      const { error } = await supabase
        .from('set_log_videos')
        .delete()
        .eq('id', videoId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['set-videos'] });
    },
  });
}

export function useSetVideoSignedUrl(storagePath) {
  return useQuery({
    queryKey: ['set-video-url', storagePath],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      if (error) throw error;
      return data.signedUrl;
    },
    enabled: !!storagePath,
    staleTime: (SIGNED_URL_TTL_SECONDS - 60) * 1000,
  });
}
