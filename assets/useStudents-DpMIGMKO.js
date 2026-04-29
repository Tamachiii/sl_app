import{c as s}from"./query-DSVREm7o.js";import{u as n,s as u}from"./index-Dx26Ta5p.js";function o(){const{user:e}=n();return s({queryKey:["students"],queryFn:async()=>{const{data:r,error:t}=await u.from("students").select(`
          *,
          profile:profiles!students_profile_id_fkey(full_name)
        `).order("created_at");if(t)throw t;return r},enabled:!!e})}function i(){const{user:e}=n();return s({queryKey:["my-student-id",e==null?void 0:e.id],queryFn:async()=>{const{data:r,error:t}=await u.from("students").select("id").eq("profile_id",e.id).single();if(t)throw t;return r.id},enabled:!!(e!=null&&e.id)})}export{i as a,o as u};
