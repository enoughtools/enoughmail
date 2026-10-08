import type {Email,GetResult,MailClient} from './jmap';
import { composeSourceAttachments } from './compose-content';
/** Metadata rows never become editable message content: load the immutable source first. */
export async function loadComposeEmail(client:MailClient,accountId:string,emailId:string,requireDraft=false):Promise<Email>{
 const result=await client.call<GetResult<Email>>('Email/get',{ids:[emailId],fetchAllBodyValues:true,maxBodyValueBytes:0},accountId);
 const email=result.list.find(value=>value.id===emailId);if(!email)throw new Error('This message is unavailable. Refresh your mailbox.');
 if(requireDraft&&!email.keywords.$draft)throw new Error('This message is no longer a draft. Refresh before editing.');
 const textBody=email.textBody?.filter(part=>!part.type||part.type==='text/plain');
 const htmlBody=email.htmlBody?.filter(part=>!part.type||part.type==='text/html');
 for(const part of [...(textBody||[]),...(htmlBody||[])]){const body=part.partId?email.bodyValues?.[part.partId]:undefined;if(!body||typeof body.value!=='string'||body.isTruncated)throw new Error('The complete message body could not be loaded. Retry before editing or replying.');}
 return {...email,textBody,htmlBody,attachments:composeSourceAttachments(email)};
}
