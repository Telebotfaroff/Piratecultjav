import { getSupabase } from '../database/supabase.ts';
export interface MediaPart { id:string; source_chat_id:string; source_message_id:number; part_number:number; part_total:number|null; caption:string|null; media_type:string; file_size:number|null; }
export interface MediaPartGroup { id:string; source_chat_id:string; group_key:string; title:string|null; expected_parts:number|null; part_count:number; parts:MediaPart[]; }
export async function searchMediaPartGroups(query:string,limit=10):Promise<MediaPartGroup[]> {
 const term=String(query||'').trim(); if(!term)return [];
 const safe=term.replace(/[%_]/g,'\\$&');
 const {data,error}=await getSupabase().from('media_part_groups').select('id,source_chat_id,group_key,title,expected_parts,part_count').or('group_key.ilike.%'+safe+'%,title.ilike.%'+safe+'%').order('updated_at',{ascending:false}).limit(Math.min(Math.max(limit,1),20));
 if(error)throw new Error('Multipart search failed: '+error.message);
 return (data||[]) as MediaPartGroup[];
}
export async function getMediaPartGroup(id:string):Promise<MediaPartGroup|null>{
 const db=getSupabase();const {data:group,error}=await db.from('media_part_groups').select('id,source_chat_id,group_key,title,expected_parts,part_count').eq('id',id).maybeSingle();
 if(error)throw new Error(error.message);if(!group)return null;
 const {data:parts,error:pe}=await db.from('media_source_refs').select('id,source_chat_id,source_message_id,part_number,part_total,caption,media_type,file_size').eq('source_chat_id',group.source_chat_id).eq('part_group_key',group.group_key).order('part_number',{ascending:true}).order('source_message_id',{ascending:true});
 if(pe)throw new Error(pe.message);return {...group,parts:(parts||[]) as MediaPart[]};
}