import{c as t}from"./query-BBurVEW5.js";import{u,s as a}from"./index-DUcESuS8.js";function f(){const{user:r}=u();return t({queryKey:["students"],queryFn:async()=>{const{data:s,error:e}=await a.from("students").select(`
          *,
          profile:profiles!students_profile_id_fkey(full_name)
        `).order("created_at");if(e)throw e;return s},enabled:!!r})}export{f as u};
