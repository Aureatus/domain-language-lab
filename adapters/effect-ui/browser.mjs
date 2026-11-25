import {Effect,Layer,Schema} from 'effect';
import {Command,UiSchema} from '@effect/ui';
import {BrowserHost,Html} from '@effect/ui/html';
import {createApplicationClient} from '../../application/client.mjs';
import {acceptsSnapshot} from '../../application/snapshot.mjs';
import {submissionControls,submissionStep} from '../../application/submission.mjs';

const StorageKeyCodec=Schema.fromJsonString(Schema.Tuple([Schema.Literal('effect-ui/spike'),Schema.String,Schema.String,Schema.String]));
const SavedSubmissionCodec=Schema.fromJsonString(Schema.NullOr(Schema.Struct({
  id:Schema.String,
  body:Schema.Struct({actor:Schema.String,action:Schema.String,args:Schema.Record(Schema.String,Schema.String)})
})));
const encodeStorageKey=Schema.encodeSync(StorageKeyCodec);
const decodeSavedSubmission=Schema.decodeUnknownSync(SavedSubmissionCodec);
const encodeSavedSubmission=Schema.encodeSync(SavedSubmissionCodec);

const Message=UiSchema.TaggedEnum({
  DraftChanged:{field:Schema.String,value:Schema.String},
  Submitted:{id:Schema.String}, CheckRequested:{}, RetryRequested:{},
  SubmissionObserved:{event:Schema.Unknown},
  RefreshRequested:{}, SnapshotReceived:{snapshot:Schema.Unknown}, RefreshFailed:{}
});
const phaseText={
  editing:'Ready to submit.', submitting:'Sending your request…',
  unknown:'No response received. Check the original submission before sending another.',
  checking:'Checking the original submission…',
  retryable:'No receipt found. Retry the same submission to avoid sending a duplicate.'
};

function actionForm({actor,action,fields,contractId,snapshot,client,storage}){
  const key=encodeStorageKey(['effect-ui/spike',contractId,actor.id,action.id]);
  const saved=decodeSavedSubmission(storage.getItem(key)??'null');
  const clearSaved=()=>{try{storage.removeItem(key);}catch{/* A reload can safely check the same receipt again. */}};
  const observe=event=>Message.SubmissionObserved({event});
  const observeReceipt=result=>{
    if(!['pending','committed','rejected'].includes(result.status))return observe({type:'lost'});
    clearSaved();
    return observe({type:'found',result});
  };
  const Execute=Command.make('Execute',{args:{submission:Schema.Unknown,persist:Schema.Boolean}},({submission,persist})=>Effect.promise(async()=>{
    const {id,body}=submission;
    try{if(persist)storage.setItem(key,encodeSavedSubmission({id,body}));}
    catch{return observe({type:'invalid',message:'Could not store the submission identity. The request was not sent.'});}
    try{
      return observeReceipt(await client.execute({...body,submissionId:id}));
    }catch(error){
      if(error.notSubmitted){clearSaved();return observe({type:'invalid',message:error.message});}
      return observe({type:'lost'});
    }
  }));
  const Reconcile=Command.make('Reconcile',{args:{id:Schema.String}},({id})=>Effect.promise(async()=>{
    try{
      const result=await client.reconcile({actor:actor.id,submissionId:id});
      if(result.status==='not-found')return observe({type:'missing'});
      return observeReceipt(result);
    }catch{return observe({type:'lost'});}
  }));
  const Refresh=Command.make('Refresh',{args:{}},()=>Effect.promise(async()=>{
    try{return Message.SnapshotReceived({snapshot:await client.snapshot()});}
    catch{return Message.RefreshFailed();}
  }));
  const nextSnapshot=(current,next)=>next&&acceptsSnapshot(current,next,contractId)?next:current;
  const available=model=>model.snapshot.availability[actor.id][action.id];
  const updateSubmission=($,event,command)=>{
    const submission=submissionStep($.model.submission,event);
    const next=$.evolve({submission});
    return command?next.run(command(submission)):next;
  };

  return Html.component({
    name:'DerivedActionForm',
    model:Schema.Struct({
      draft:Schema.Record(Schema.String,Schema.String),
      submission:Schema.Unknown,snapshot:Schema.Unknown,refreshing:Schema.Boolean,refreshError:Schema.Boolean
    }),
    message:Message
  }).make({
    init:()=>({
      draft:Object.fromEntries(fields.map(({name})=>[name,(saved?.body.args??snapshot.defaults[actor.id][action.id])[name]??''])),
      submission:saved?{...saved,phase:'unknown'}:{phase:'editing'},
      snapshot,refreshing:false,refreshError:false
    }),
    update:{
      DraftChanged:($,{field,value})=>submissionControls($.model.submission).submit?
        $.evolve({draft:{...$.model.draft,[field]:value}}):$.model,
      Submitted:($,{id})=>available($.model)&&submissionControls($.model.submission).submit?
        updateSubmission($,{type:'submit',id,body:{actor:actor.id,action:action.id,args:$.model.draft}},
          submission=>Execute.make({submission,persist:true})):$.model,
      CheckRequested:$=>submissionControls($.model.submission).check?
        updateSubmission($,{type:'check'},({id})=>Reconcile.make({id})):$.model,
      RetryRequested:$=>submissionControls($.model.submission).retry?
        updateSubmission($,{type:'retry'},submission=>Execute.make({submission,persist:false})):$.model,
      SubmissionObserved:($,{event})=>$.evolve({
        submission:submissionStep($.model.submission,event),
        snapshot:nextSnapshot($.model.snapshot,event.result?.snapshot)
      }),
      RefreshRequested:$=>$.model.refreshing?$.model:$.evolve({refreshing:true,refreshError:false}).run(Refresh.make({})),
      SnapshotReceived:($,{snapshot})=>$.evolve({snapshot:nextSnapshot($.model.snapshot,snapshot),refreshing:false}),
      RefreshFailed:$=>$.evolve({refreshing:false,refreshError:true})
    },
    view:(h,model)=>{
      const {submission}=model,controls=submissionControls(submission);
      return h.div.children(
        h.p.children(actor.label),
        h.form.attr('data-action',action.id).onSubmit(()=>Message.Submitted({id:crypto.randomUUID()})).children(
          h.h2.children(action.label),
          h.p.children(action.description),
          h.fieldset.disabled(!controls.submit).children(...fields.map(field=>
            h.label.children(field.label,
              h.input.attr('name',field.name).attr('type',field.widget).attr('required','')
                .value(model.draft[field.name])
                .onInput(({value})=>Message.DraftChanged({field:field.name,value}))
            )
          )),
          h.button.attr('type','submit').disabled(!controls.submit||!available(model)).children(action.label)
        ),
        h.section.children(
          h.p.attr('role','status').children(submission.result?.message??submission.message??phaseText[submission.phase]),
          controls.check&&h.button.onClick(Message.CheckRequested()).children('Check submission'),
          controls.retry&&h.button.onClick(Message.RetryRequested()).children('Retry same submission'),
          h.button.disabled(model.refreshing).onClick(Message.RefreshRequested()).children('Refresh records'),
          h.p.children(model.refreshError?'Could not refresh records.':`Snapshot version: ${model.snapshot.snapshotVersion}`)
        )
      );
    }
  });
}

const root=document.querySelector('#app');
try{
  const client=createApplicationClient(location.origin);
  const {contractId,contract}=await client.contract();
  const query=new URLSearchParams(location.search);
  const actor=contract.actors.find(({id})=>id===(query.get('actor')??'maya'));
  const actionId=query.get('action')??'leave.request';
  if(contract.format!=='derived-application/v1'||!actor||!Object.hasOwn(contract.actions,actionId))
    throw Error('Unsupported contract, actor or action.');
  const action=contract.actions[actionId],fields=action.fields.filter(field=>!field.hidden);
  if(fields.some(({widget,schema})=>!['date','text'].includes(widget)||schema.type!=='string'))
    throw Error('This spike supports only date and text inputs.');
  const snapshot=await client.snapshot();
  if(!acceptsSnapshot(undefined,snapshot,contractId))throw Error('Invalid application snapshot.');
  const host=document.createElement('div'),heading=document.createElement('h1');
  heading.textContent=contract.title;
  root.replaceChildren(heading,host);
  const form=actionForm({actor,action,fields,contractId,snapshot,client,storage:sessionStorage});
  Layer.launch(BrowserHost.mount(form,{},host)).pipe(Effect.runFork);
}catch(error){
  root.replaceChildren(Object.assign(document.createElement('p'),{textContent:`Could not load the spike: ${error.message}`}));
}
