import type { Express,Request } from "express";
import type { AgentService } from "./agent-service.js";
/** File changes stay outside agent messages and use the native resource reload. */
export function installSystemPromptRoutes(app:Express,service:()=>AgentService,originAllowed:(req:Request)=>boolean){
	app.post("/api/system-prompt",async(req,res)=>{
		res.setHeader("Cache-Control","no-store");
		if(!originAllowed(req)||!req.is("application/json")){res.status(403).json({error:"Forbidden"});return;}
		const {clientId,cwd,conversationId,action,id,version,content}=req.body??{};
		const cs=typeof clientId==="string"?service().get(clientId):undefined;
		if(!cs||cs.switchingWorkspace||cs.cwd!==cwd||cs.conversationId!==conversationId){res.status(409).json({error:"Conversation unavailable"});return;}
		const session=cs.session;
		const valid=()=>cs.cwd===cwd&&cs.session===session&&!cs.switchingWorkspace;
		try{
			if(!["get","save","restore","retry"].includes(action))throw Error("Invalid prompt action");
			if(action!=="get"&&service().quiesceInfo().quiesced)throw Error("Service draining");
			if(action==="save"||action==="restore"){
				if(typeof id!=="string"||typeof version!=="string")throw Error("Invalid file request");
				await cs.savePromptFile(id,version,content,action==="restore");
			}
			if(action==="retry")await cs.retryPromptReload();
			if(!valid())throw Error("Conversation changed");
			const state=await cs.systemPromptState();
			if(!valid())throw Error("Conversation changed");
			res.json(state);
		}catch(error){res.status(400).json({error:(error as Error).message});}
	});
}
