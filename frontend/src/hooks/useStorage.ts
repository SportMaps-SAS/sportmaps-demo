import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { getStoragePath } from '@/lib/utils';
import { comprimirParaSubir, perfilPorBucket } from '@/lib/imageCompression';

export type BucketName = 'avatars' | 'medical-documents' | 'payment-receipts' | 'facility-photos' | 'identity-documents' | 'coach-certificates' | 'school-assets' | 'equipment-photos';

function friendlyUploadError(message: string): string {
  if (/mime type .* is not supported/i.test(message)) {
    return 'Ese tipo de archivo no está permitido acá. Sube una imagen (PNG, JPG, WEBP o SVG).';
  }
  if (/exceeded the maximum allowed size/i.test(message)) {
    return 'El archivo pesa más de lo permitido.';
  }
  return message;
}

export function useStorage() {
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  const uploadFile = async (
    original: File,
    bucket: BucketName,
    path?: string
  ): Promise<string | null> => {
    try {
      setUploading(true);

      if (!original || !original.name) {
        throw new Error('No se ha seleccionado ningún archivo válido');
      }

      // INF-13: el plan Free de Supabase se llenó de fotos de celular sin
      // reducir. Si no aplica (PDF, SVG, ya liviano), devuelve el original.
      const file = await comprimirParaSubir(original, perfilPorBucket(bucket));

      // Generar nombre único
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;

      // Para payment-receipts guardar en subcarpeta con UID del padre
      // Esto permite que la política RLS de storage filtre por foldername[1] = auth.uid()
      // Estructura: payment-receipts/{uid}/{filename}
      let filePath: string;
      if (bucket === 'payment-receipts') {
        const { data: { user } } = await supabase.auth.getUser();
        filePath = user ? `${user.id}/${fileName}` : fileName;
      } else if (path) {
        filePath = `${path}/${fileName}`;
      } else {
        filePath = fileName;
      }

      // Subir archivo
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file, {
          cacheControl: '3600',
          // upsert:false a propósito: el nombre ya es único, y el upsert de
          // Storage (INSERT … ON CONFLICT) exige además una policy SELECT
          // sobre la ruta. 20261028110434 quitó las SELECT de bucket completo.
          upsert: false,
          contentType: file.type || undefined,
        });

      if (uploadError) throw uploadError;

      // Buckets privados — retornar el filePath para guardar en BD
      const privateBuckets: BucketName[] = [
        'identity-documents',
        'coach-certificates',
        'medical-documents',
        'payment-receipts',
        'equipment-photos',
      ];

      if (privateBuckets.includes(bucket)) {
        return filePath;
      }

      // Buckets públicos — retornar URL pública
      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      return urlData.publicUrl;
    } catch (error: unknown) {
      console.error('Error uploading file:', error);
      const rawMessage = error instanceof Error ? error.message : 'No se pudo subir el archivo';
      const message = friendlyUploadError(rawMessage);
      toast({
        title: '❌ Error',
        description: message,
        variant: 'destructive',
      });
      return null;
    } finally {
      setUploading(false);
    }
  };

  const deleteFile = async (bucket: BucketName, filePath: string): Promise<boolean> => {
    try {
      const { error } = await supabase.storage
        .from(bucket)
        .remove([filePath]);

      if (error) throw error;

      toast({
        title: '✅ Archivo eliminado',
        description: 'El archivo se ha eliminado correctamente',
      });

      return true;
    } catch (error: unknown) {
      console.error('Error deleting file:', error);
      const message = error instanceof Error ? error.message : 'No se pudo eliminar el archivo';
      toast({
        title: '❌ Error',
        description: message,
        variant: 'destructive',
      });
      return false;
    }
  };

  const getFileUrl = (bucket: BucketName, filePath: string): string => {
    const { data } = supabase.storage
      .from(bucket)
      .getPublicUrl(getStoragePath(filePath));

    return data.publicUrl;
  };

  const createSignedPathUrl = async (
    bucket: BucketName,
    filePath: string,
    expiresIn = 3600
  ): Promise<string | null> => {
    try {
      const cleanPath = getStoragePath(filePath);
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(cleanPath, expiresIn);

      if (error) throw error;
      return data.signedUrl;
    } catch (error) {
      console.error('Error generating signed URL:', error);
      return null;
    }
  };

  return {
    uploadFile,
    deleteFile,
    getFileUrl,
    createSignedPathUrl,
    uploading,
  };
}