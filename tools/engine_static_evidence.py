"""从游戏 WebAssembly 和适配文件中静态提取证据，并限制保留的样本数量。"""
import hashlib, json, re
from collections import Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]; BUILD=ROOT/'gta5data/b/8b0b5899ed'
WASM=BUILD/'game.wasm'; JS=BUILD/'game.js'
b=WASM.read_bytes()
def uleb(pos):
    n=0; shift=0
    while True:
        x=b[pos]; pos+=1; n|=(x&127)<<shift
        if not x&128:return n,pos
        shift+=7
        if shift>70: raise ValueError('无效的 LEB 编码')
def name(pos):
    n,pos=uleb(pos); return b[pos:pos+n].decode('utf-8','replace'),pos+n
def skip_limits(pos):
    flag=b[pos];pos+=1; _,pos=uleb(pos)
    if flag&1: _,pos=uleb(pos)
    return pos
def skip_type(pos, kind):
    if kind==0: return skip_limits(pos)
    if kind==1: return b[pos+1] and skip_limits(pos+1) # 当前未使用
    if kind==2: return skip_limits(pos)
    if kind==3: return skip_limits(pos)
    raise ValueError(kind)
sections=[]; custom=[]; imports=[]; exports=[]; memories=[]; pos=8
sec_names={0:'custom',1:'type',2:'import',3:'function',4:'table',5:'memory',6:'global',7:'export',8:'start',9:'element',10:'code',11:'data',12:'data_count',13:'tag'}
while pos<len(b):
    start=pos; sid=b[pos]; pos+=1; sz,pos=uleb(pos); payload=pos; end=pos+sz
    if end>len(b): raise ValueError('节的范围超出了文件长度')
    sections.append({'id':sid,'name':sec_names.get(sid,'unknown'),'offset':start,'payload_offset':payload,'payload_bytes':sz,'end_offset':end})
    if sid==0:
        n,p=name(payload); custom.append({'name':n,'section_offset':start,'payload_offset':p,'payload_bytes':end-p})
    elif sid==2:
        n,p=uleb(payload)
        for _ in range(n):
            mod,p=name(p); field,p=name(p); kind=b[p]; p+=1; desc=p
            if kind==0: index,p=uleb(p); detail={'type_index':index}
            elif kind==1: elem=b[p];p+=1;p=skip_limits(p); detail={'element_type':elem}
            elif kind==2: p=skip_limits(p); detail={'limits':True}
            elif kind==3: vt=b[p]; mut=b[p+1];p+=2; detail={'value_type':vt,'mutable':bool(mut)}
            elif kind==4: index,p=uleb(p); detail={'type_index':index}
            else: raise ValueError('未知的导入类型')
            imports.append({'module':mod,'field':field,'kind':kind,'offset':desc-1,**detail})
    elif sid==5:
        n,p=uleb(payload)
        for _ in range(n):
            at=p; p=skip_limits(p); memories.append({'offset':at})
    elif sid==7:
        n,p=uleb(payload)
        for _ in range(n):
            nm,p=name(p); kind=b[p];p+=1; ix,p=uleb(p); exports.append({'name':nm,'kind':kind,'index':ix})
    pos=end

# 仅索引含有明确构建、引擎、编译器或作者归属线索的连续可打印字符串。
terms=re.compile(r'(emscripten|clang|llvm|wasm|webgpu|d3d11|dxgi|rage|rockstar|grand theft|gta[ _-]?v|gta5|\.cpp|\.cc|\.cxx|\.h(?:pp)?(?:\x00|$)|/[A-Za-z0-9_. -]+\.(?:cpp|cc|cxx|h|hpp))',re.I)
hits=[]
for m in re.finditer(rb'[ -~]{4,}',b):
    s=m.group().decode('ascii','replace')
    if terms.search(s): hits.append({'offset':m.start(),'text':s[:1000]})
hits=hits[:300]
priority_patterns={
 'game_version': rb'(?:GTA ?V|Grand Theft Auto|GTA5)[ -~]{0,100}',
 'rockstar_or_rage': rb'(?:Rockstar|RAGE|RageNet|ragenet)[ -~]{0,140}',
 'source_paths': rb'(?:[A-Za-z]:[\\/]|(?:/|\\\\)[A-Za-z0-9_. -]+[\\/])[ -~]{0,180}\\.(?:cpp|cc|cxx|hpp|h)',
 'compiler_markers': rb'(?:clang|llvm|emscripten)[ -~]{0,120}',
 'version_or_build_markers': rb'(?:version|build)[ -~]{0,140}',
}
priority_hits={}
for label,pat in priority_patterns.items():
    vals=[]
    for m in re.finditer(pat,b,re.I):
        vals.append({'offset':m.start(),'text':m.group().decode('ascii','replace')[:500]})
        if len(vals)>=80: break
    priority_hits[label]=vals

# 标准 name 自定义节保留了函数符号。遍历整个节，
# 但每个类别只保留有限数量的样本。
name_summary={k:{'count':0,'samples':[]} for k in ('rage_native','version_or_build','product_id','pc_dx11','console_backend','browser_port')}
name_rules={
 'rage_native': re.compile(r'\brage::',re.I),
 'version_or_build': re.compile(r'(?:version|build|patch)',re.I),
 'product_id': re.compile(r'(?:gta(?:v|5)|grand.?theft)',re.I),
 'pc_dx11': re.compile(r'(?:d3d11|dxgi|direct3d|win32|windows|\bpc\b)',re.I),
 'console_backend': re.compile(r'(?:xenon|orbis|durango|prospero|ps3|ps4|ps5)',re.I),
 'browser_port': re.compile(r'(?:emscripten|wasm|httpfs|wgpu|webgpu)',re.I),
}
for c in custom:
    if c['name']!='name': continue
    p=c['payload_offset']; end=c['payload_offset']+c['payload_bytes']
    while p<end:
        subid=b[p]; p+=1; size,p=uleb(p); subend=p+size
        if subid==1:
            count,p2=uleb(p)
            for _ in range(count):
                idx,p2=uleb(p2); nm,p2=name(p2)
                for label,rule in name_rules.items():
                    if rule.search(nm):
                        name_summary[label]['count']+=1
                        if len(name_summary[label]['samples'])<30:
                            name_summary[label]['samples'].append({'function_index':idx,'name':nm})
        p=subend

# 仅扫描 Wasm 数据节中的产品、平台和构建值线索。
# 通用词语只有在带有类似数值的后缀或产品、平台词语时才保留。
data_sec=next(x for x in sections if x['name']=='data')
data_blob=b[data_sec['payload_offset']:data_sec['end_offset']]
data_categories={k:{'count':0,'samples':[]} for k in ('source_paths','version_or_build_values','product_identifiers','pc_dx11','console_backend')}
data_rules={
 'source_paths': re.compile(r'^[A-Za-z]:[\\/].+',re.I),
 'version_or_build_values': re.compile(r'\b(?:build|version|patch)\b.*(?:\d|0x[0-9a-f]+)',re.I),
 'product_identifiers': re.compile(r'(?:gta(?:v|5)|grand.?theft|rockstar)',re.I),
 'pc_dx11': re.compile(r'(?:d3d11|dxgi|direct3d|win32|windows|platform_pc|\bpc\b)',re.I),
 'console_backend': re.compile(r'(?:xenon|orbis|durango|prospero|ps3|ps4|ps5)',re.I),
}
for m in re.finditer(rb'[ -~]{4,}',data_blob):
    text=m.group().decode('ascii','replace')
    for label,rule in data_rules.items():
        if rule.search(text):
            data_categories[label]['count']+=1
            if len(data_categories[label]['samples'])<40:
                data_categories[label]['samples'].append({'offset':data_sec['payload_offset']+m.start(),'text':text[:1000]})

# 明确搜索 AI 工具标记，报告准确匹配项的偏移和上下文；
# 是否存在这些标记，比根据代码风格猜测更有意义。
ai_tokens=(b'claude',b'anthropic',b'openai',b'chatgpt',b'codex',b'copilot',b'cursor')
ai_token_hits=[]
lower=b.lower()
for token in ai_tokens:
    at=0
    while True:
        at=lower.find(token,at)
        if at<0: break
        ai_token_hits.append({'token':token.decode(),'offset':at,'context':b[max(0,at-80):at+len(token)+160].decode('ascii','replace')})
        at+=len(token)
glue=JS.read_text(encoding='utf-8')
glue_terms=['Emscripten','em-pthread','WebAssembly.Memory','wasmMemory','PThread','game.wasm','__main_argc_argv','wasm_httpfs_manifest_js','wgpu_start_worker']
glue_hits=[]
for term in glue_terms:
    at=glue.find(term)
    if at>=0: glue_hits.append({'term':term,'byte_offset':at,'line':glue.count('\n',0,at)+1,'context':glue[max(0,at-120):at+len(term)+180]})
out={'files':{'game.wasm':{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'magic':b[:4].hex(),'version_le_u32':int.from_bytes(b[4:8],'little')},'game.js':{'bytes':len(JS.read_bytes()),'sha256':hashlib.sha256(JS.read_bytes()).hexdigest()}},'sections':sections,'custom_sections':custom,'imports':imports,'exports':exports,'defined_memory_sections':memories,'targeted_printable_string_hits':hits,'priority_string_hits':priority_hits,'name_section_symbol_summary':name_summary,'data_section_summary':{'payload_offset':data_sec['payload_offset'],'payload_bytes':len(data_blob),'categories':data_categories},'ai_tool_token_hits':ai_token_hits,'game_js_hits':glue_hits,'counts':{'sections':len(sections),'imports':len(imports),'exports':len(exports),'custom_sections':len(custom),'targeted_string_hits':len(hits),'ai_tool_token_hits':len(ai_token_hits)}}
(ROOT/'docs/snapshot/engine-evidence.json').write_text(json.dumps(out,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'sections':[(x['name'],x['payload_bytes']) for x in sections],'custom':custom,'imports':len(imports),'exports':len(exports),'hits':hits[:30]},indent=2))
