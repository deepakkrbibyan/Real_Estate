
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://twjaukkwjgenrlhkjneg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3amF1a2t3amdlbnJsaGtqbmVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4ODQ4MjcsImV4cCI6MjA4MzQ2MDgyN30.W6eKFMU4VBsAnKbRDcrJKYNn8_iKvFA9zlF3a3lxbEk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
