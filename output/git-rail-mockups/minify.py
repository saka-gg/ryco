import re,sys
for v in sys.argv[1:]:
    s=open(f'{v}.html').read()
    s=re.sub(r'\n[ \t]+','\n',s)
    s=re.sub(r'\n{2,}','\n',s)
    s=re.sub(r'/\*[^*]*\*+(?:[^/*][^*]*\*+)*/','',s)  # css comments
    open(f'{v}.html','w').write(s)
    print(v,len(s))
